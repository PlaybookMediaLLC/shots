package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/agentclients"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/authstore"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/browser"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/sessionstate"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/collab"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/config"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/githubapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/httpapi"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/mcp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/media"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/notifications"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/onboarding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/platformai"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/quota"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/tenantpublishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialapi"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/socialconnect"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/telemetry"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalonboarding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalpublishing"
	"github.com/getsentry/sentry-go"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// First, so clients built below use the traced default transport.
	defer telemetry.Start(ctx, "publishing-backend")()
	cfg, err := config.LoadBackend()
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		os.Exit(1)
	}
	db, err := database.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.Error("database unavailable", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	temporalClient, err := temporalpublishing.Dial(ctx, temporalpublishing.ConnectionConfig{
		APIKey: cfg.APIKey, Address: cfg.Address, Namespace: cfg.Namespace, TLS: cfg.TLS,
	})
	if err != nil {
		slog.Error("Temporal unavailable", "error", err)
		os.Exit(1)
	}
	defer temporalClient.Close()
	if !cfg.TLS {
		if err := temporalpublishing.RegisterSearchAttributes(ctx, temporalClient, cfg.Namespace); err != nil {
			slog.Error("Temporal search attributes unavailable", "error", err)
			os.Exit(1)
		}
	}
	scheduler := temporalpublishing.NewScheduler(temporalClient, temporalpublishing.SchedulerConfig{
		ActivityTaskQueue: cfg.ActivityTaskQueue, ActivityTimeout: cfg.ActivityTimeout,
		MaxAttempts: cfg.MaxAttempts, Namespace: cfg.Namespace,
		RetryDelay: cfg.RetryDelay, WorkflowTaskQueue: cfg.WorkflowTaskQueue,
	})
	objects, err := media.NewS3StoreFromEnvironment()
	if err != nil {
		slog.Error("media storage unavailable", "error", err)
		os.Exit(1)
	}
	agentClients := agentclients.New(db.SQL)
	configuration := product.NewConfiguration(db.Client).WithNotifications(notifications.New(db.SQL, db.Client)).WithAuthStore(authstore.New(db.SQL)).
		WithAgentClients(agentClients).WithInvitationEmailVerification(os.Getenv("AUTH_REQUIRE_EMAIL_VERIFICATION") != "false").
		WithAssetDownloads(cfg.ServiceToken, os.Getenv("BETTER_AUTH_URL"))
	if objects != nil {
		configuration.WithObjectStore(objects)
	}
	// Starting a sign-in needs the browser provider here; jobs run on the worker.
	captureKeys, err := sessionstate.FromEnvironment()
	if err != nil {
		slog.Error("invalid capture session key")
		os.Exit(1)
	}
	if provider := browser.FromEnvironment(); provider != nil && captureKeys != nil {
		configuration.WithAuthenticatedCapture(browser.Runner{Provider: provider}, captureKeys)
	}
	// Live draft posts' engagement is read through the direct social publisher,
	// which shares this database (RFC 013).
	if publisher, closeShared, err := tenantpublishing.OpenShared(ctx, cfg.DatabaseURL, publishing.NewRepository(db.Client),
		media.NewTenantObjects(objects)); err == nil {
		defer closeShared()
		configuration.WithPostMetrics(publisher).WithAccountStanding(publisher).WithAnalytics(publisher)
	} else {
		slog.Warn("post engagement unavailable", "error", err)
	}
	// Outbound webhooks (RFC 024): the key seals signing secrets.
	webhookKey, err := config.WebhookEncryptionKey()
	if err != nil {
		slog.Error("invalid webhook configuration", "error", err)
		os.Exit(1)
	}
	configuration.WithWebhooks(webhookKey, nil)
	// End-to-end runs publish drafts through the local provider fixture (RFC 025).
	if os.Getenv("PLATFORM_E2E_DRAFT_PLATFORM") == "enabled" {
		product.EnableE2EDraftPlatform()
	}
	// Content draft collaboration (RFC 013): only the backend can sign tokens.
	if key := os.Getenv("COLLAB_TOKEN_SECRET"); key != "" {
		configuration.WithCollabKey([]byte(key))
	}
	github, err := githubapp.FromEnvironment()
	if err != nil {
		slog.Error("invalid GitHub App configuration", "error", err)
		os.Exit(1)
	}
	if github != nil {
		configuration.WithGitHubApp(github)
		configuration.WithCodeReader(github)
	} else {
		// Without the App, Code Studio still imports public repositories and gists.
		configuration.WithCodeReader(githubapp.NewPublic())
	}
	// The MCP server counts per-key calls on the same Redis; nil skips them.
	var limiter product.QuotaCounter
	if redisURL := os.Getenv("REDIS_URL"); redisURL != "" {
		// Collaboration access counts are shared by every backend replica.
		epochs, err := collab.NewRedisEpochs(redisURL)
		if err != nil {
			slog.Error("invalid collaboration epoch configuration", "error", err)
			os.Exit(1)
		}
		defer epochs.Close()
		configuration.WithCollabEpochs(epochs)
		counter, err := quota.NewRedisCounter(redisURL)
		if err != nil {
			slog.Error("invalid quota counter configuration", "error", err)
			os.Exit(1)
		}
		defer counter.Close()
		limiter = counter
		configuration.WithQuotaCounter(counter)
		meter, err := counter.MonthlyMeter()
		if err != nil {
			slog.Error("monthly quota meter unavailable", "error", err)
			os.Exit(1)
		}
		configuration.WithMonthlyMeter(meter)
	}

	temporalonboarding.InitSentry("publishing-backend")
	defer sentry.Flush(2 * time.Second)
	// Without OPENROUTER_API_KEY the onboarding drafts come from page metadata.
	var model onboarding.Model
	if client := platformai.FromEnvironment(); client != nil {
		model = client
	}
	// SOCIAL_API_URL keeps the HTTP social API (the browser e2e suite mocks it);
	// otherwise channels connect in process.
	var verifier httpapi.DestinationVerifier
	if socialURL := os.Getenv("SOCIAL_API_URL"); socialURL != "" {
		verifier = socialapi.New(socialURL, &http.Client{Timeout: 20 * time.Second}, nil)
	} else {
		connector, closeConnector, err := socialconnect.Open(ctx, cfg.DatabaseURL, db.Client)
		if err != nil {
			slog.Error("social connections unavailable", "error", err)
			os.Exit(1)
		}
		defer closeConnector()
		verifier = connector
	}
	server := &http.Server{
		Addr: fmt.Sprintf(":%d", cfg.Port),
		Handler: telemetry.Handler(httpapi.NewWithOnboarding(publishing.NewRepository(db.Client), scheduler, verifier, cfg.ServiceToken, configuration,
			&onboarding.Service{Background: &temporalonboarding.Client{SeedSurfaces: os.Getenv("PLATFORM_ONBOARDING_SURFACES") == "enabled", Temporal: temporalClient},
				FastPath: &onboarding.FastPath{Fetcher: onboarding.NewFetcher(), Model: model}, Store: configuration}), false),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	servers := []*http.Server{server}
	if port := os.Getenv("PUBLIC_PORT"); port != "" {
		handler, err := publicHandler(configuration, limiter, agentClients)
		if err != nil {
			slog.Error("MCP server unavailable", "error", err)
			os.Exit(1)
		}
		public := &http.Server{
			Addr: ":" + port,
			// The public port faces the internet: it never joins a caller's trace.
			Handler:           telemetry.Handler(handler, true),
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       60 * time.Second,
			// Above the MCP tool call timeout (60s), so a slow call still answers.
			WriteTimeout: 90 * time.Second,
			IdleTimeout:  60 * time.Second,
		}
		servers = append(servers, public)
		go func() {
			slog.Info("public MCP listener", "port", port)
			if err := public.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				slog.Error("public listener stopped", "error", err)
				os.Exit(1)
			}
		}()
	}
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		// Both ports stop accepting at once and drain within the same budget.
		var wait sync.WaitGroup
		for _, s := range servers {
			wait.Go(func() { _ = s.Shutdown(shutdownCtx) })
		}
		wait.Wait()
	}()
	slog.Info("publishing backend listening", "port", cfg.Port)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("backend stopped", "error", err)
		os.Exit(1)
	}
	// ListenAndServe returns as Shutdown starts: wait up to 10 seconds for
	// open requests, so their spans are flushed and the database closes after
	// them. A longer request (an MCP call can take 60 s) is cut off.
	<-drained
}

// publicHandler is all the public port serves: the MCP server (RFC 026), its
// OAuth token and registration endpoints, and their well-known documents.
// The product API stays on the internal port.
func publicHandler(configuration *product.Configuration, limiter product.QuotaCounter, clients httpapi.AgentClientRegistry) (http.Handler, error) {
	// The metadata names PLATFORM_MCP_URL, and client secrets are sealed with
	// JWT_SECRET, the key the social backend registered them with.
	if os.Getenv("PLATFORM_MCP_URL") == "" || os.Getenv("JWT_SECRET") == "" {
		return nil, errors.New("PUBLIC_PORT requires PLATFORM_MCP_URL and JWT_SECRET")
	}
	server, err := mcp.New(mcp.Config{Product: configuration, Capture: capture.FromEnvironment(), Limiter: limiter})
	if err != nil {
		return nil, err
	}
	return server.Handler(httpapi.NewAgentOAuth(clients, configuration)), nil
}
