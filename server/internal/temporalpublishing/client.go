package temporalpublishing

import (
	"context"
	"crypto/tls"
	"errors"
	"log/slog"
	"time"

	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	workflowservice "go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/client"
	temporalotel "go.temporal.io/sdk/contrib/opentelemetry"
	"go.temporal.io/sdk/interceptor"
)

type ConnectionConfig struct {
	APIKey    string
	Address   string
	Namespace string
	TLS       bool
}

type SchedulerConfig struct {
	ActivityTaskQueue string
	ActivityTimeout   time.Duration
	MaxAttempts       int
	Namespace         string
	RetryDelay        time.Duration
	WorkflowTaskQueue string
}

type Scheduler struct {
	client client.Client
	config SchedulerConfig
}

func Dial(ctx context.Context, cfg ConnectionConfig) (client.Client, error) {
	options := client.Options{HostPort: cfg.Address, Namespace: cfg.Namespace}
	if cfg.TLS {
		options.ConnectionOptions.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	if cfg.APIKey != "" {
		options.Credentials = client.NewAPIKeyStaticCredentials(cfg.APIKey)
	}
	// Workflows and activities continue the trace of the request that started
	// them, and the SDK reports task latency, failures and worker slots. Both
	// use the global providers, which are no-ops until telemetry.Start.
	tracing, err := temporalotel.NewTracingInterceptor(temporalotel.TracerOptions{})
	if err != nil {
		return nil, err
	}
	options.Interceptors = []interceptor.ClientInterceptor{tracing}
	options.MetricsHandler = temporalotel.NewMetricsHandler(temporalotel.MetricsHandlerOptions{UseMonotonicCounters: true,
		OnError: func(err error) { slog.Warn("Temporal metric unavailable", "error", err) }})
	return client.DialContext(ctx, options)
}

func NewScheduler(temporalClient client.Client, cfg SchedulerConfig) *Scheduler {
	return &Scheduler{client: temporalClient, config: cfg}
}

func (s *Scheduler) Start(ctx context.Context, input ScheduleInput) error {
	_, err := s.client.SignalWithStartWorkflow(ctx, WorkflowID(input.PostID), PokeSignalName, PokeSignal{}, client.StartWorkflowOptions{
		ID:                                       WorkflowID(input.PostID),
		TaskQueue:                                s.config.WorkflowTaskQueue,
		WorkflowIDConflictPolicy:                 enumspb.WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING,
		WorkflowIDReusePolicy:                    enumspb.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE,
		WorkflowExecutionErrorWhenAlreadyStarted: false,
		Memo:                                     map[string]any{"organizationId": input.OrganizationID, "postId": input.PostID},
		TypedSearchAttributes:                    postSearchAttributes(input.OrganizationID, input.PostID),
	}, WorkflowNameV2, WorkflowInput{
		ActivityTaskQueue: s.config.ActivityTaskQueue,
		ActivityTimeout:   s.config.ActivityTimeout,
		MaxAttempts:       s.config.MaxAttempts,
		MainTaskQueue:     s.config.WorkflowTaskQueue,
		OrganizationID:    input.OrganizationID,
		PostID:            input.PostID,
		RetryDelay:        s.config.RetryDelay,
		ScheduledFor:      input.ScheduledFor,
	})
	var alreadyStarted *serviceerror.WorkflowExecutionAlreadyStarted
	if errors.As(err, &alreadyStarted) {
		return nil
	}
	return err
}

// StartDelete starts deleting a published post from its platform. A delete
// already running for the post is joined; a finished one runs again, which
// retries its refused parts.
func (s *Scheduler) StartDelete(ctx context.Context, organizationID, postID, requestedBy string) error {
	_, err := s.client.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
		ID:                       DeleteWorkflowID(postID),
		TaskQueue:                s.config.WorkflowTaskQueue,
		WorkflowIDConflictPolicy: enumspb.WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING,
		WorkflowIDReusePolicy:    enumspb.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE,
		Memo:                     map[string]any{"organizationId": organizationID, "postId": postID},
	}, DeleteWorkflowName, DeleteWorkflowInput{
		ActivityTaskQueue: s.config.ActivityTaskQueue, MainTaskQueue: s.config.WorkflowTaskQueue,
		OrganizationID: organizationID, PostID: postID, RequestedBy: requestedBy,
	})
	return err
}

func (s *Scheduler) StartMissingWorkflow(ctx context.Context) error {
	_, err := s.client.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
		ID:                       MissingWorkflowID,
		TaskQueue:                s.config.WorkflowTaskQueue,
		WorkflowIDConflictPolicy: enumspb.WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING,
		WorkflowIDReusePolicy:    enumspb.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE,
	}, MissingWorkflowName)
	return err
}

func (s *Scheduler) Cancel(ctx context.Context, postID string) error {
	err := s.client.SignalWorkflow(ctx, WorkflowID(postID), "", CancelSignalName, CancelSignal{})
	var notFound *serviceerror.NotFound
	if errors.As(err, &notFound) {
		return nil
	}
	return err
}

// Running reports whether a post's workflow run is still open. A run Temporal
// no longer knows, or a run ID it never issued (a pre-Temporal publisher's),
// is not running.
func (s *Scheduler) Running(ctx context.Context, postID, runID string) (bool, error) {
	described, err := s.client.DescribeWorkflowExecution(ctx, WorkflowID(postID), runID)
	var notFound *serviceerror.NotFound
	var invalid *serviceerror.InvalidArgument
	if errors.As(err, &notFound) || errors.As(err, &invalid) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return described.GetWorkflowExecutionInfo().GetStatus() == enumspb.WORKFLOW_EXECUTION_STATUS_RUNNING, nil
}

func (s *Scheduler) Ping(ctx context.Context) error {
	_, err := s.client.WorkflowService().DescribeNamespace(ctx, &workflowservice.DescribeNamespaceRequest{Namespace: s.config.Namespace})
	return err
}
