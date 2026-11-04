package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"slices"
	"syscall"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/config"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/database"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/enrichment"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/githubapp"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/maintenance"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/media"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/notifications"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/onboarding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/platformai"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/quota"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/social/tenantpublishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/telemetry"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalbatches"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalmaintenance"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalonboarding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalpublishing"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalreleaseautomation"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/webhooks"
	"github.com/getsentry/sentry-go"
	"github.com/lucsky/cuid"
	workflowservice "go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/interceptor"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// First, so clients built below use the traced default transport.
	defer telemetry.Start(ctx, "publishing-orchestrator")()
	cfg, err := config.LoadOrchestrator()
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
	repository := publishing.NewRepository(db.Client)
	objectStore, err := media.NewS3StoreFromEnvironment()
	if err != nil || objectStore == nil {
		slog.Error("media storage unavailable", "error", err)
		os.Exit(1)
	}
	tenantObjects := media.NewTenantObjects(objectStore)
	// The social Ent projection and canonical scheduled_post use the same DB.
	provider, closeShared, err := tenantpublishing.OpenShared(ctx, cfg.DatabaseURL, repository, tenantObjects)
	if err != nil {
		slog.Error("direct social publisher unavailable", "error", err)
		os.Exit(1)
	}
	defer closeShared()
	activities := temporalpublishing.NewActivities(repository, provider)
	scheduler := temporalpublishing.NewScheduler(temporalClient, temporalpublishing.SchedulerConfig{
		ActivityTaskQueue: cfg.ActivityTaskQueue, ActivityTimeout: cfg.ActivityTimeout,
		MaxAttempts: cfg.MaxAttempts, Namespace: cfg.Namespace,
		RetryDelay: cfg.RetryDelay, WorkflowTaskQueue: cfg.WorkflowTaskQueue,
	})
	recovery := temporalpublishing.NewRecoveryActivities(repository, scheduler)
	workflowWorker := worker.New(temporalClient, cfg.WorkflowTaskQueue, worker.Options{
		MaxHeartbeatThrottleInterval: 15 * time.Second,
		OnFatalError:                 func(err error) { slog.Error("Temporal workflow worker failed", "error", err); stop() },
	})
	workflowWorker.RegisterWorkflowWithOptions(temporalpublishing.PostWorkflowV1, workflow.RegisterOptions{Name: temporalpublishing.WorkflowNameV1})
	workflowWorker.RegisterWorkflowWithOptions(temporalpublishing.PostWorkflowV2, workflow.RegisterOptions{Name: temporalpublishing.WorkflowNameV2})
	workflowWorker.RegisterWorkflowWithOptions(temporalpublishing.MissingPostWorkflow, workflow.RegisterOptions{Name: temporalpublishing.MissingWorkflowName})
	workflowWorker.RegisterActivityWithOptions(activities.Prepare, activity.RegisterOptions{Name: temporalpublishing.PrepareActivityName})
	workflowWorker.RegisterActivityWithOptions(activities.Begin, activity.RegisterOptions{Name: temporalpublishing.BeginActivityName})
	workflowWorker.RegisterActivityWithOptions(activities.CompleteV2, activity.RegisterOptions{Name: temporalpublishing.CompleteActivityName})
	workflowWorker.RegisterActivityWithOptions(activities.FailV2, activity.RegisterOptions{Name: temporalpublishing.FailActivityName})
	workflowWorker.RegisterActivityWithOptions(activities.MarkUnknown, activity.RegisterOptions{Name: temporalpublishing.MarkUnknownActivityName})
	workflowWorker.RegisterActivityWithOptions(activities.PlanAutomations, activity.RegisterOptions{Name: temporalpublishing.PlanAutomationsActivityName})
	workflowWorker.RegisterActivityWithOptions(recovery.Recover, activity.RegisterOptions{Name: temporalpublishing.RecoverActivityName})

	var activityWorker, legacyActivityWorker worker.Worker
	newActivityWorker := func(queue string) worker.Worker {
		concurrency := max(1, cfg.ActivityConcurrency/cfg.WorkerConcurrencyDivider)
		activityWorker := worker.New(temporalClient, queue, worker.Options{
			DisableWorkflowWorker: true, MaxConcurrentActivityExecutionSize: concurrency,
			MaxHeartbeatThrottleInterval: 15 * time.Second,
			OnFatalError:                 func(err error) { slog.Error("Temporal activity worker failed", "error", err); stop() },
		})
		// Keep the V1 registrations until no V1 execution remains in Temporal.
		activityWorker.RegisterActivityWithOptions(activities.Prepare, activity.RegisterOptions{Name: temporalpublishing.PrepareActivityName})
		activityWorker.RegisterActivityWithOptions(activities.Publish, activity.RegisterOptions{Name: temporalpublishing.PublishActivityName})
		activityWorker.RegisterActivityWithOptions(activities.MarkUnknown, activity.RegisterOptions{Name: temporalpublishing.MarkUnknownActivityName})
		activityWorker.RegisterActivityWithOptions(activities.Submit, activity.RegisterOptions{Name: temporalpublishing.SubmitActivityName})
		activityWorker.RegisterActivityWithOptions(activities.RunAutoActions, activity.RegisterOptions{Name: temporalpublishing.AutoActionsActivityName})
		activityWorker.RegisterActivityWithOptions(activities.RunAutomation, activity.RegisterOptions{Name: temporalpublishing.RunAutomationActivityName})
		activityWorker.RegisterActivityWithOptions(activities.Check, activity.RegisterOptions{Name: temporalpublishing.CheckActivityName})
		return activityWorker
	}
	if !slices.Contains(cfg.ExcludedQueues, cfg.ActivityTaskQueue) {
		activityWorker = newActivityWorker(cfg.ActivityTaskQueue)
		// cutover: workflows started before the queue rename carry the legacy queue
		// in their input. Poll it until they drain, then delete this worker.
		if cfg.ActivityTaskQueue != temporalpublishing.LegacyActivityQueue {
			legacyActivityWorker = newActivityWorker(temporalpublishing.LegacyActivityQueue)
		}
	}

	// The onboarding agent's background read (docs/rfcs/032) on its own queue.
	// Onboarding spends no AI credits, so its store needs no quota meter.
	onboardingStore := product.NewConfiguration(db.Client)
	fetcher := onboarding.NewFetcher()
	onboardingActivities := &temporalonboarding.Activities{Fetcher: fetcher, Store: onboardingStore,
		Enricher: &enrichment.Enricher{Providers: enrichment.FromEnvironment(fetcher), Store: onboardingStore}}
	if model := platformai.FromEnvironment(); model != nil {
		onboardingActivities.Model = model
	}
	var onboardingWorker worker.Worker
	if !slices.Contains(cfg.ExcludedQueues, temporalonboarding.TaskQueue) {
		temporalonboarding.InitSentry("publishing-orchestrator")
		defer sentry.Flush(2 * time.Second)
		onboardingWorker = worker.New(temporalClient, temporalonboarding.TaskQueue, worker.Options{
			Interceptors:                       []interceptor.WorkerInterceptor{&temporalonboarding.Observer{}},
			MaxConcurrentActivityExecutionSize: max(1, 10/cfg.WorkerConcurrencyDivider), MaxHeartbeatThrottleInterval: 5 * time.Second,
			OnFatalError: func(err error) { slog.Error("Temporal onboarding worker failed", "error", err); stop() },
		})
		temporalonboarding.Register(onboardingWorker, onboardingActivities)
		if err := onboardingWorker.Start(); err != nil {
			slog.Error("Temporal onboarding worker did not start", "error", err)
			os.Exit(1)
		}
		defer onboardingWorker.Stop()
	}

	github, err := githubapp.FromEnvironment()
	if err != nil {
		slog.Error("invalid GitHub App configuration")
		os.Exit(1)
	}
	// Batch submits schedule here, so this store judges an account as the API does.
	automationStore := product.NewConfiguration(db.Client).WithObjectStore(objectStore).WithAccountStanding(provider)
	if github != nil {
		// render_code_visual reads a merged pull request's diff only where its owner allowed it.
		automationStore.WithGitHubApp(github).WithCodeReader(github)
	}
	// Paid workflow copy needs a model and the credit meter that bills it;
	// without both this worker never advertises the ai capability.
	if model := platformai.FromEnvironment(); model != nil {
		automationStore.WithAutomationModel(model)
	}
	if renderer := product.AutomationRendererFromEnvironment(); renderer != nil {
		// One signed web client renders creatives and lays out canvases.
		automationStore.WithAutomationRenderer(renderer).WithAutomationCanvases(renderer)
	}
	if redisURL := os.Getenv("REDIS_URL"); redisURL != "" {
		counter, err := quota.NewRedisCounter(redisURL)
		if err != nil {
			slog.Error("invalid quota counter configuration")
			os.Exit(1)
		}
		defer counter.Close()
		meter, err := counter.MonthlyMeter()
		if err != nil {
			slog.Error("monthly quota meter unavailable")
			os.Exit(1)
		}
		automationStore.WithMonthlyMeter(meter)
	}
	// A batch submit schedules with the same media, standing and quota as the API.
	if os.Getenv("PLATFORM_E2E_DRAFT_PLATFORM") == "enabled" {
		product.EnableE2EDraftPlatform()
	}
	if !slices.Contains(cfg.ExcludedQueues, temporalbatches.TaskQueue) {
		batchWorker := worker.New(temporalClient, temporalbatches.TaskQueue, worker.Options{
			MaxConcurrentActivityExecutionSize: max(1, 5/cfg.WorkerConcurrencyDivider),
			OnFatalError:                       func(err error) { slog.Error("Temporal batch worker failed", "error", err); stop() },
		})
		temporalbatches.Register(batchWorker, &temporalbatches.Activities{Publisher: scheduler, Store: automationStore})
		if err := batchWorker.Start(); err != nil {
			slog.Error("batch worker did not start", "error", err)
			os.Exit(1)
		}
		defer batchWorker.Stop()
	}
	if !slices.Contains(cfg.ExcludedQueues, temporalreleaseautomation.TaskQueue) {
		automationWorker := worker.New(temporalClient, temporalreleaseautomation.TaskQueue, worker.Options{
			MaxConcurrentActivityExecutionSize: max(1, 5/cfg.WorkerConcurrencyDivider), MaxHeartbeatThrottleInterval: 5 * time.Second,
			OnFatalError: func(err error) { slog.Error("Temporal release automation worker failed"); stop() },
		})
		temporalreleaseautomation.Register(automationWorker, &temporalreleaseautomation.Activities{Store: automationStore})
		if err := automationWorker.Start(); err != nil {
			slog.Error("release automation worker did not start")
			os.Exit(1)
		}
		defer automationWorker.Stop()
		leaseID := cuid.New()
		go func() {
			ticker := time.NewTicker(20 * time.Second)
			defer ticker.Stop()
			for {
				if github != nil && cfg.RunMaintenance {
					leaseCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
					if err := automationStore.AdvertiseReleaseAutomationExecutor(leaseCtx, leaseID, automationStore.AutomationCapabilities()...); err != nil {
						slog.Warn("release automation capability lease not renewed")
					}
					cancel()
				}
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
				}
			}
		}()
	}

	if cfg.RunMaintenance {
		retention, err := database.Open(ctx, cfg.AuditRetentionDatabaseURL)
		if err != nil {
			slog.Error("audit retention database unavailable")
			os.Exit(1)
		}
		defer retention.Close()
		events := product.NewConfiguration(db.Client).WithWebhooks(cfg.WebhookEncryptionKey, nil).WithCapturer(capture.FromEnvironment()).WithPostMetrics(provider).WithAnalytics(provider)
		if objectStore != nil {
			events.WithObjectStore(objectStore)
		}
		events.WithAutomationDispatcher(&temporalreleaseautomation.Client{Temporal: temporalClient})
		if github != nil {
			events.WithGitHubApp(github)
		}
		jobs := &maintenance.Store{Analytics: events, Tokens: provider, Activity: notifications.New(db.SQL, db.Client), DB: db.SQL, RetentionDB: retention.SQL, Objects: tenantObjects, Events: events,
			Onboarding: &temporalonboarding.Client{Temporal: temporalClient},
			Drains:     maintenance.NewDrainSender(cfg.AuditDrainEncryptionKey),
			Webhooks:   webhooks.NewDispatcher(db.SQL, cfg.WebhookEncryptionKey),
			Mail:       &maintenance.Mailer{APIKey: cfg.ResendAPIKey, From: cfg.EmailFrom, BaseURL: cfg.AuthBaseURL, SigningSecret: cfg.AuthSecret, PostalAddress: cfg.CompanyPostalAddress},
		}
		maintenanceWorker := worker.New(temporalClient, temporalmaintenance.TaskQueue, worker.Options{
			MaxConcurrentActivityExecutionSize: 5, OnFatalError: func(err error) { slog.Error("maintenance worker failed"); stop() },
		})
		temporalmaintenance.Register(maintenanceWorker, temporalmaintenance.RunnerFunc(func(ctx context.Context, job string) (int, error) {
			if job == "social-analytics" {
				n, err := events.CollectDueAnalytics(ctx)
				if err != nil {
					return n, err
				}
				m, err := jobs.Run(ctx, job)
				return n + m, err
			}
			if job == "scheduled-posts" {
				return recovery.DispatchDue(ctx)
			}
			return jobs.Run(ctx, job)
		}))
		if err := maintenanceWorker.Start(); err != nil {
			slog.Error("maintenance worker did not start")
			os.Exit(1)
		}
		defer maintenanceWorker.Stop()
		reconcileCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		err = temporalmaintenance.Reconcile(reconcileCtx, temporalClient.ScheduleClient())
		cancel()
		if err != nil {
			slog.Error("maintenance schedules unavailable", "error", err)
			os.Exit(1)
		}
		slog.Info("maintenance schedules ready", "count", len(temporalmaintenance.Jobs))
	}

	health := healthHandler(repository, temporalClient, cfg.Namespace)
	server := &http.Server{Addr: fmt.Sprintf(":%d", cfg.Port), Handler: health, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		slog.Info("publishing orchestrator health server listening", "port", cfg.Port)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("orchestrator health server stopped", "error", err)
			stop()
		}
	}()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	if activityWorker != nil {
		if err := activityWorker.Start(); err != nil {
			slog.Error("Temporal activity worker did not start", "error", err)
			os.Exit(1)
		}
	}
	if legacyActivityWorker != nil {
		if err := legacyActivityWorker.Start(); err != nil {
			slog.Error("Temporal legacy activity worker did not start", "error", err)
			os.Exit(1)
		}
		defer legacyActivityWorker.Stop()
	}
	if err := workflowWorker.Start(); err != nil {
		if activityWorker != nil {
			activityWorker.Stop()
		}
		slog.Error("Temporal workflow worker did not start", "error", err)
		os.Exit(1)
	}
	if cfg.RunCron {
		if err := scheduler.StartMissingWorkflow(ctx); err != nil {
			workflowWorker.Stop()
			if activityWorker != nil {
				activityWorker.Stop()
			}
			slog.Error("missing-post workflow did not start", "error", err)
			os.Exit(1)
		}
	}
	<-ctx.Done()
	workflowWorker.Stop()
	if activityWorker != nil {
		activityWorker.Stop()
	}
}

type healthStore interface{ Ping(context.Context) error }
type temporalHealth interface {
	WorkflowService() workflowservice.WorkflowServiceClient
}

func healthHandler(store healthStore, temporal temporalHealth, namespace string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": "publishing-orchestrator"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		if err := store.Ping(ctx); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "database is unavailable"})
			return
		}
		if _, err := temporal.WorkflowService().DescribeNamespace(ctx, &workflowservice.DescribeNamespaceRequest{Namespace: namespace}); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Temporal is unavailable"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})
	return mux
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
