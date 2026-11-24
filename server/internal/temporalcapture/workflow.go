// Package temporalcapture runs authenticated capture jobs. Workflow history
// holds only IDs and retry delays: never session state, URLs, or page content.
package temporalcapture

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

const (
	TaskQueue                    = "platform-capture"
	JobWorkflowName              = "platform-capture-job-v1"
	ConnectWorkflow              = "platform-capture-connection-v1"
	DeploymentCaptureWorkflow    = "platform-capture-deployment-v1"
	RunActivity                  = "platform-capture-run-v1"
	CompleteActivity             = "platform-capture-complete-connection-v1"
	DeploymentCaptureActivity    = "platform-capture-deployment-run-v1"
	maxJobRounds                 = 200
	deploymentCaptureMaxAttempts = 4
	activityHeartbeats           = 30 * time.Second
)

// Input names a job or connection; it is safe in workflow history.
type Input struct {
	OrganizationID string `json:"organizationId"`
	ID             string `json:"id"`
}

// JobWorkflow runs attempts until the job is done, sleeping durably between
// them, so a slow deployment holds neither a worker slot nor a browser. A person
// reconnecting starts a new workflow; none waits for them.
func JobWorkflow(ctx workflow.Context, input Input) error {
	ctx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: 4 * time.Minute, HeartbeatTimeout: activityHeartbeats,
		RetryPolicy: &temporal.RetryPolicy{InitialInterval: 5 * time.Second, MaximumInterval: time.Minute, MaximumAttempts: 3}})
	for round := 0; round < maxJobRounds; round++ {
		var outcome product.CaptureJobOutcome
		if err := workflow.ExecuteActivity(ctx, RunActivity, input).Get(ctx, &outcome); err != nil {
			return err
		}
		if outcome.Done {
			return nil
		}
		if err := workflow.Sleep(ctx, time.Duration(outcome.RetryAfterSeconds)*time.Second); err != nil {
			return err
		}
	}
	return temporal.NewNonRetryableApplicationError("Capture job exceeded its attempts", "CaptureJobExhausted", nil)
}

// ConnectionWorkflow validates one finished sign-in. It runs once: the login
// browser closes during the attempt, so only a new sign-in can try again.
func ConnectionWorkflow(ctx workflow.Context, input Input) error {
	ctx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: 4 * time.Minute, HeartbeatTimeout: activityHeartbeats,
		RetryPolicy: &temporal.RetryPolicy{MaximumAttempts: 1}})
	return workflow.ExecuteActivity(ctx, CompleteActivity, input).Get(ctx, nil)
}

// DeploymentWorkflow runs public & authenticated deployment captures off the
// global outbox loop so one slow tenant cannot stall outbox delivery across
// other workspaces, with bounded retries for transient screenshot provider errors.
func DeploymentWorkflow(ctx workflow.Context, input Input) error {
	ctx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: 10 * time.Minute, HeartbeatTimeout: activityHeartbeats,
		RetryPolicy: &temporal.RetryPolicy{InitialInterval: 10 * time.Second, MaximumInterval: 2 * time.Minute, MaximumAttempts: deploymentCaptureMaxAttempts}})
	return workflow.ExecuteActivity(ctx, DeploymentCaptureActivity, input).Get(ctx, nil)
}

// Activities adapts Temporal onto the product's capture operations.
type Activities struct{ Store *product.Configuration }

func keepAlive(ctx context.Context) func() {
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				activity.RecordHeartbeat(ctx)
			}
		}
	}()
	return func() { close(done) }
}

// safeError keeps provider and database text out of workflow history.
func safeError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, product.ErrNotEligible) {
		return temporal.NewNonRetryableApplicationError("Capture target is no longer eligible", "CaptureNotEligible", nil)
	}
	return temporal.NewApplicationError("Capture activity failed", "CaptureInfrastructure")
}

// Run performs one attempt.
func (a *Activities) Run(ctx context.Context, input Input) (*product.CaptureJobOutcome, error) {
	defer keepAlive(ctx)()
	outcome, err := a.Store.RunCaptureJob(ctx, input.OrganizationID, input.ID)
	return outcome, safeError(err)
}

// Complete validates a finished sign-in in a fresh browser.
func (a *Activities) Complete(ctx context.Context, input Input) error {
	defer keepAlive(ctx)()
	return safeError(a.Store.CompleteCaptureConnection(ctx, input.OrganizationID, input.ID))
}

// CaptureDeployment runs deployment surface capture inside Temporal. Non-final
// attempts allow transient screenshot failures to trigger a retry; the final
// attempt persists surface failures and finalizes the DeploymentEvent row.
func (a *Activities) CaptureDeployment(ctx context.Context, input Input) error {
	defer keepAlive(ctx)()
	retryTransient := int(activity.GetInfo(ctx).Attempt) < deploymentCaptureMaxAttempts
	return safeError(a.Store.RunDeploymentCapture(ctx, input.OrganizationID, input.ID, retryTransient))
}

// Register adds the capture workflows and activities to a worker.
func Register(w worker.Worker, a *Activities) {
	w.RegisterWorkflowWithOptions(JobWorkflow, workflow.RegisterOptions{Name: JobWorkflowName})
	w.RegisterWorkflowWithOptions(ConnectionWorkflow, workflow.RegisterOptions{Name: ConnectWorkflow})
	w.RegisterWorkflowWithOptions(DeploymentWorkflow, workflow.RegisterOptions{Name: DeploymentCaptureWorkflow})
	w.RegisterActivityWithOptions(a.Run, activity.RegisterOptions{Name: RunActivity})
	w.RegisterActivityWithOptions(a.Complete, activity.RegisterOptions{Name: CompleteActivity})
	w.RegisterActivityWithOptions(a.CaptureDeployment, activity.RegisterOptions{Name: DeploymentCaptureActivity})
}

// Client starts capture workflows from the outbox. A lost acknowledgement finds
// the same workflow, since its ID derives from the job.
type Client struct{ Temporal client.Client }

func (c *Client) start(ctx context.Context, id, name string, input Input) error {
	_, err := c.Temporal.ExecuteWorkflow(ctx, client.StartWorkflowOptions{ID: id, TaskQueue: TaskQueue, WorkflowExecutionTimeout: 2 * time.Hour,
		WorkflowIDConflictPolicy: enumspb.WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING, WorkflowIDReusePolicy: enumspb.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE}, name, input)
	var duplicate *serviceerror.WorkflowExecutionAlreadyStarted
	if errors.As(err, &duplicate) {
		return nil
	}
	return err
}

// StartCaptureJob starts one workflow per job and resume.
func (c *Client) StartCaptureJob(ctx context.Context, org, jobID string, resume int) error {
	return c.start(ctx, fmt.Sprintf("capture-job-%s-%d", jobID, resume), JobWorkflowName, Input{OrganizationID: org, ID: jobID})
}

// StartCaptureConnection validates a finished sign-in. Each sign-in has its own
// outbox event, so a reconnect must not collide with an earlier workflow.
func (c *Client) StartCaptureConnection(ctx context.Context, org, connectionID string) error {
	_, err := c.Temporal.ExecuteWorkflow(ctx, client.StartWorkflowOptions{ID: "capture-connection-" + connectionID, TaskQueue: TaskQueue, WorkflowExecutionTimeout: 10 * time.Minute,
		WorkflowIDConflictPolicy: enumspb.WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING, WorkflowIDReusePolicy: enumspb.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE}, ConnectWorkflow, Input{OrganizationID: org, ID: connectionID})
	return err
}

// StartDeploymentCapture starts one durable workflow per deployment event,
// decoupling slow screenshot captures from the global outbox dispatcher.
func (c *Client) StartDeploymentCapture(ctx context.Context, org, deploymentID string) error {
	return c.start(ctx, "capture-deployment-"+deploymentID, DeploymentCaptureWorkflow, Input{OrganizationID: org, ID: deploymentID})
}
