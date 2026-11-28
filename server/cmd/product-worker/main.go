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
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/browser"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/emailauth"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/capture/sessionstate"
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
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalcapture"
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
	db, err := database.OpenWithOptions(ctx, cfg.DatabaseURL, database.PoolConfigFromEnv(15, 8))
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
	// The social Ent projection and canonical scheduled_post share the worker DB pool.
	provider := tenantpublishing.NewWithSQL(db.SQL, repository, tenantObjects).
		WithReconnectNotifier(repository.EmitConnectionNeedsReconnect)
	activities := temporalpublishing.NewActivities(repository, provider)
	scheduler := temporalpublishing.NewScheduler(temporalClient, temporalpublishing.SchedulerConfig{
		ActivityTaskQueue: cfg.ActivityTaskQueue, ActivityTimeout: cfg.ActivityTimeout,
		MaxAttempts: cfg.MaxAttempts, Namespace: cfg.Namespace,
		RetryDelay: cfg.RetryDelay, WorkflowTaskQueue: cfg.WorkflowTaskQueue,
	})
	recovery := temporalpublishing.NewRecoveryActivities(repository, scheduler)
	workflowWorker := worker.New(temporalClient, cfg.WorkflowTaskQueue, worker.Options{
		MaxConcurrentActivityExecutionSize: max(1, 20/cfg.WorkerConcurrencyDivider),
		MaxHeartbeatThrottleInterval:       15 * time.Second,
		OnFatalError:                       func(err error) { slog.Error("Temporal workflow worker failed", "error", err); stop() },
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
	workflowWorker.RegisterWorkflowWithOptions(temporalpublishing.PostDeleteWorkflow, workflow.RegisterOptions{Name: temporalpublishing.DeleteWorkflowName})
	workflowWorker.RegisterActivityWithOptions(activities.PlanDeletion, activity.RegisterOptions{Name: temporalpublishing.PlanDeletionActivityName})
	workflowWorker.RegisterActivityWithOptions(activities.SettleDeletion, activity.RegisterOptions{Name: temporalpublishing.SettleDeletionActivityName})

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
		activityWorker.RegisterActivityWithOptions(activities.DeletePart, activity.RegisterOptions{Name: temporalpublishing.DeletePartActivityName})
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

	// Share one OpenRouter HTTP client across onboarding, release automation,
	// and maintenance sweeps so connection pools are reused.
	aiModel := platformai.FromEnvironment()

	// The onboarding agent's background read (docs/rfcs/032) on its own queue.
	// Onboarding spends no AI credits, so its store needs no quota meter.
	onboardingStore := product.NewConfiguration(db.Client)
	fetcher := onboarding.NewFetcher()
	onboardingActivities := &temporalonboarding.Activities{Fetcher: fetcher, Store: onboardingStore,
		Enricher: &enrichment.Enricher{Providers: enrichment.FromEnvironment(fetcher), Store: onboardingStore}}
	if aiModel != nil {
		onboardingActivities.Model = aiModel
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
	automationStore := product.NewConfiguration(db.Client).WithObjectStore(objectStore).WithAccountStanding(provider).
		WithCapturer(capture.FromEnvironment())
	captureKeys, err := sessionstate.FromEnvironment()
	if err != nil {
		slog.Error("invalid capture session key")
		os.Exit(1)
	}
	captureProvider := browser.FromEnvironment()
	if captureKeys != nil && captureProvider != nil {
		var runner product.CaptureRunner = browser.Runner{Provider: captureProvider}
		if agentRunner := browser.AgentRunnerFromEnvironment(captureProvider); agentRunner != nil {
			runner = agentRunner
		}
		automationStore.WithAuthenticatedCapture(runner, captureKeys)
	}
	// Unattended email sign-in (RFC 007A) runs its attempts on this worker.
	emailAuth, err := emailauth.SettingsFromEnvironment()
	if err != nil {
		slog.Error("invalid capture email sign-in configuration", "error", err)
		os.Exit(1)
	}
	if emailAuth != nil {
		automationStore.WithEmailAuth(emailAuth)
	}
	if github != nil {
		// render_code_visual reads a merged pull request's diff only where its owner allowed it.
		automationStore.WithGitHubApp(github).WithCodeReader(github)
	}
	// Paid workflow copy needs a model and the credit meter that bills it;
	// without both this worker never advertises the ai capability.
	if aiModel != nil {
		automationStore.WithAutomationModel(aiModel)
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
	deploymentCaptureEnabled := capture.FromEnvironment() != nil || automationStore.CaptureAvailable()
	if deploymentCaptureEnabled && !slices.Contains(cfg.ExcludedQueues, temporalcapture.TaskQueue) {
		captureWorker := worker.New(temporalClient, temporalcapture.TaskQueue, worker.Options{
			// Shared with design rendering's provider account: a low ceiling keeps
			// capacity for renders, and a stalled page holds one slot, not the queue.
			MaxConcurrentActivityExecutionSize: max(1, 3/cfg.WorkerConcurrencyDivider), MaxHeartbeatThrottleInterval: 5 * time.Second,
			OnFatalError: func(err error) { slog.Error("Temporal capture worker failed"); stop() },
		})
		temporalcapture.Register(captureWorker, &temporalcapture.Activities{Store: automationStore})
		if err := captureWorker.Start(); err != nil {
			slog.Error("capture worker did not start")
			os.Exit(1)
		}
		defer captureWorker.Stop()
		if automationStore.CaptureAvailable() {
			go func() {
				ticker := time.NewTicker(time.Minute)
				defer ticker.Stop()
				for {
					select {
					case <-ctx.Done():
						return
					case <-ticker.C:
					}
					reclaimCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
					if err := automationStore.ReclaimCaptureResources(reclaimCtx); err != nil {
						slog.Warn("capture cleanup did not finish")
					}
					cancel()
				}
			}()
		}
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
		retentionSQL := db.SQL
		if cfg.AuditRetentionDatabaseURL != cfg.DatabaseURL {
			retentionPool := database.PoolConfigFromEnv(2, 1)
			retentionPool.MaxOpenConns = 2
			retentionPool.MaxIdleConns = 1
			retention, err := database.OpenWithOptions(ctx, cfg.AuditRetentionDatabaseURL, retentionPool)
			if err != nil {
				slog.Error("audit retention database unavailable")
				os.Exit(1)
			}
			defer retention.Close()
			retentionSQL = retention.SQL
		}
		events := product.NewConfiguration(db.Client).WithWebhooks(cfg.WebhookEncryptionKey, nil).WithCapturer(capture.FromEnvironment()).WithPostMetrics(provider).WithAnalytics(provider)
		if objectStore != nil {
			events.WithObjectStore(objectStore)
		}
		if renderer := product.AutomationRendererFromEnvironment(); renderer != nil {
			events.WithAutomationRenderer(renderer)
		}
		automationDispatcher := &temporalreleaseautomation.Client{Temporal: temporalClient}
		events.WithAutomationDispatcher(automationDispatcher)
		if !slices.Contains(cfg.ExcludedQueues, temporalreleaseautomation.TaskQueue) {
			events.WithKitDispatcher(automationDispatcher)
		}
		if deploymentCaptureEnabled {
			events.WithCaptureDispatcher(&temporalcapture.Client{Temporal: temporalClient})
		}
		if github != nil {
			events.WithGitHubApp(github)
		}
		// The voice-commands sweep retries parses that waited on the model.
		if aiModel != nil {
			events.WithAutomationModel(aiModel)
		}
		activityService := notifications.New(db.SQL, db.Client)
		activityService.DispatchWorkers = 4
		jobs := &maintenance.Store{Analytics: events, Tokens: provider, Activity: activityService, DB: db.SQL, RetentionDB: retentionSQL, Objects: tenantObjects, Events: events,
			Onboarding: &temporalonboarding.Client{Temporal: temporalClient},
			Drains:     maintenance.NewDrainSender(cfg.AuditDrainEncryptionKey),
			Webhooks:   webhooks.NewDispatcher(db.SQL, cfg.WebhookEncryptionKey),
			Mail:       &maintenance.Mailer{APIKey: cfg.ResendAPIKey, From: cfg.EmailFrom, BaseURL: cfg.AuthBaseURL, SigningSecret: cfg.AuthSecret, PostalAddress: cfg.CompanyPostalAddress},
		}
		maintenanceWorker := worker.New(temporalClient, temporalmaintenance.TaskQueue, worker.Options{
			BackgroundActivityContext:          ctx,
			MaxConcurrentActivityExecutionSize: max(1, 4/cfg.WorkerConcurrencyDivider),
			OnFatalError:                       func(err error) { slog.Error("maintenance worker failed"); stop() },
		})
		// Temporal runs (scheduled or on-demand/E2E) wait for any in-flight
		// poller lock so explicit triggers always execute a fresh pass.
		temporalmaintenance.Register(maintenanceWorker, temporalmaintenance.RunnerFunc(func(ctx context.Context, job string) (int, error) {
			if job == "scheduled-posts" {
				return jobs.WithLockWait(ctx, job, recovery.DispatchDue)
			}
			return jobs.RunWait(ctx, job)
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
		// Keep scheduled-posts on a dedicated slot so slow external-HTTP jobs
		// (audit drains, communications, analytics) can never starve due posts.
		var scheduledPostsJob, otherPollJobs []maintenance.PollJob
		for _, job := range maintenance.DefaultPollJobs {
			if job.Name == "scheduled-posts" {
				scheduledPostsJob = append(scheduledPostsJob, job)
			} else {
				otherPollJobs = append(otherPollJobs, job)
			}
		}
		stopScheduledPostsPoller := (&maintenance.Scheduler{
			Runner: func(ctx context.Context, job string) (int, error) {
				return jobs.WithLock(ctx, job, recovery.DispatchDue)
			},
			Jobs:          scheduledPostsJob,
			MaxConcurrent: 1,
		}).Start(ctx)
		defer stopScheduledPostsPoller()
		stopMaintenancePoller := (&maintenance.Scheduler{
			Runner:        jobs.Run,
			Jobs:          otherPollJobs,
			MaxConcurrent: max(2, 3/cfg.WorkerConcurrencyDivider),
		}).Start(ctx)
		defer stopMaintenancePoller()
		slog.Info("maintenance ready", "scheduled", len(temporalmaintenance.ScheduledJobs), "retired", len(temporalmaintenance.RetiredScheduleJobs), "polled", len(maintenance.DefaultPollJobs))
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
	if cfg.RunCron || cfg.RunMaintenance {
		// MissingPostWorkflow is superseded by the scheduled-posts maintenance
		// poller and had no ContinueAsNew bound. Cancel any open execution cleanly;
		// the workflow stays registered above for replay safety.
		cancelCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		if err := scheduler.CancelMissingWorkflow(cancelCtx); err != nil {
			slog.Warn("retired missing-post workflow could not be cancelled", "error", err)
		}
		cancel()
	}
	if cfg.RunCron && !cfg.RunMaintenance {
		// Local dev with RUN_CRON=true and RUN_MAINTENANCE=false still dispatches due posts.
		cronLocks := &maintenance.Store{DB: db.SQL}
		stopCronPoller := (&maintenance.Scheduler{
			Runner: func(ctx context.Context, job string) (int, error) {
				return cronLocks.WithLock(ctx, job, recovery.DispatchDue)
			},
			Jobs:          []maintenance.PollJob{{Name: "scheduled-posts", Interval: time.Minute}},
			MaxConcurrent: 1,
		}).Start(ctx)
		defer stopCronPoller()
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
