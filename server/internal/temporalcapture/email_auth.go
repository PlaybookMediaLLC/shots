package temporalcapture

import (
	"context"
	"errors"
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

// Unattended email sign-in (RFC 007A). History holds the attempt ID, safe
// step flags, and timers only: the email, its link or code, and the browser
// state live inside ApplyAuthActivity and nowhere else.
const (
	EmailAuthWorkflowName = "platform-capture-email-auth-v1"
	RequestAuthActivity   = "platform-capture-email-auth-request-v1"
	CheckAuthActivity     = "platform-capture-email-auth-check-v1"
	ApplyAuthActivity     = "platform-capture-email-auth-apply-v1"
	// EmailSignal wakes a waiting attempt early; the database stays the truth.
	EmailSignal = "capture-email-auth-received"

	emailAuthPoll = 10 * time.Second
	// emailAuthMaxWait outlasts the longest attempt (a 4-minute email wait plus
	// setup); the attempt's own deadline ends it first.
	emailAuthMaxWait = 12 * time.Minute
)

// EmailAuthWorkflow requests one sign-in email, waits for it, and applies it.
// Neither browser step is ever retried: the request may already have sent an
// email, and the apply step spends a one-time challenge.
func EmailAuthWorkflow(ctx workflow.Context, input Input) error {
	once := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: 4 * time.Minute, HeartbeatTimeout: activityHeartbeats,
		RetryPolicy: &temporal.RetryPolicy{MaximumAttempts: 1}})
	check := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{InitialInterval: 2 * time.Second, MaximumAttempts: 3}})
	var step product.CaptureAuthStep
	if err := workflow.ExecuteActivity(once, RequestAuthActivity, input).Get(ctx, &step); err != nil || step.Done {
		return err
	}
	signal := workflow.GetSignalChannel(ctx, EmailSignal)
	started := workflow.Now(ctx)
	for !step.Matched {
		// Bounded by time, not by checks: signals must not spend the budget.
		if workflow.Now(ctx).Sub(started) > emailAuthMaxWait {
			// The attempt's own deadline ends it long before this; the
			// cleanup sweep closes anything left.
			return temporal.NewNonRetryableApplicationError("Email sign-in wait exceeded its checks", "CaptureAuthExhausted", nil)
		}
		timerCtx, cancel := workflow.WithCancel(ctx)
		selector := workflow.NewSelector(ctx)
		selector.AddReceive(signal, func(c workflow.ReceiveChannel, _ bool) { c.Receive(ctx, nil) })
		selector.AddFuture(workflow.NewTimer(timerCtx, emailAuthPoll), func(workflow.Future) {})
		selector.Select(ctx)
		cancel()
		if err := workflow.ExecuteActivity(check, CheckAuthActivity, input).Get(ctx, &step); err != nil || step.Done {
			return err
		}
	}
	return workflow.ExecuteActivity(once, ApplyAuthActivity, input).Get(ctx, nil)
}

// RequestAuth starts a browser and asks the app for one sign-in email.
func (a *Activities) RequestAuth(ctx context.Context, input Input) (*product.CaptureAuthStep, error) {
	defer keepAlive(ctx)()
	step, err := a.Store.RequestCaptureAuthChallenge(ctx, input.OrganizationID, input.ID)
	return step, safeAuthError(err)
}

// CheckAuth reads the attempt's durable state.
func (a *Activities) CheckAuth(ctx context.Context, input Input) (*product.CaptureAuthStep, error) {
	step, err := a.Store.CheckCaptureAuthAttempt(ctx, input.OrganizationID, input.ID)
	return step, safeAuthError(err)
}

// ApplyAuth consumes the email and commits a verified session. It returns
// no value, so nothing it read can reach workflow history.
func (a *Activities) ApplyAuth(ctx context.Context, input Input) error {
	defer keepAlive(ctx)()
	return safeAuthError(a.Store.ApplyCaptureAuthChallenge(ctx, input.OrganizationID, input.ID))
}

func safeAuthError(err error) error {
	if err == nil {
		return nil
	}
	return temporal.NewApplicationError("Email sign-in activity failed", "CaptureAuthInfrastructure")
}

// RegisterEmailAuth adds the email sign-in workflow and its activities.
func RegisterEmailAuth(w worker.Worker, a *Activities) {
	w.RegisterWorkflowWithOptions(EmailAuthWorkflow, workflow.RegisterOptions{Name: EmailAuthWorkflowName})
	w.RegisterActivityWithOptions(a.RequestAuth, activity.RegisterOptions{Name: RequestAuthActivity})
	w.RegisterActivityWithOptions(a.CheckAuth, activity.RegisterOptions{Name: CheckAuthActivity})
	w.RegisterActivityWithOptions(a.ApplyAuth, activity.RegisterOptions{Name: ApplyAuthActivity})
}

func emailAuthWorkflowID(attemptID string) string { return "capture-email-auth-" + attemptID }

// StartCaptureAuth starts one workflow per attempt; a repeated outbox
// delivery finds the same workflow.
func (c *Client) StartCaptureAuth(ctx context.Context, org, attemptID string) error {
	_, err := c.Temporal.ExecuteWorkflow(ctx, client.StartWorkflowOptions{ID: emailAuthWorkflowID(attemptID), TaskQueue: TaskQueue, WorkflowExecutionTimeout: 20 * time.Minute,
		WorkflowIDConflictPolicy: enumspb.WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING, WorkflowIDReusePolicy: enumspb.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE}, EmailAuthWorkflowName, Input{OrganizationID: org, ID: attemptID})
	var duplicate *serviceerror.WorkflowExecutionAlreadyStarted
	if errors.As(err, &duplicate) {
		return nil
	}
	return err
}

// SignalCaptureAuth wakes a waiting attempt. A finished workflow needs no wake.
func (c *Client) SignalCaptureAuth(ctx context.Context, org, attemptID string) error {
	err := c.Temporal.SignalWorkflow(ctx, emailAuthWorkflowID(attemptID), "", EmailSignal, nil)
	var missing *serviceerror.NotFound
	if errors.As(err, &missing) {
		return nil
	}
	return err
}
