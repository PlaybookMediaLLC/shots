// Package temporalbatches applies a bulk batch's frozen schedule, one item at a
// time, after the browser that asked has gone. Keep v1 registered while any v1
// workflow remains in flight.
package temporalbatches

import (
	"context"
	"errors"
	"log/slog"
	"time"

	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalpublishing"
)

const (
	TaskQueue           = "platform-content-batches"
	WorkflowName        = "platform-content-batch-submit-v1"
	NextActivity        = "content-batch-schedule-next-v1"
	UnconfirmedActivity = "content-batch-mark-unconfirmed-v1"
)

// Input names a run; its frozen requests stay in the database, not in history.
type Input struct {
	OrganizationID string `json:"organizationId"`
	RunID          string `json:"runId"`
}

// Workflow schedules a run's items in order. An item with no answer after its
// retries is marked and the rest go on: one stuck item never holds up the others.
func Workflow(ctx workflow.Context, input Input) error {
	ctx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 3 * time.Minute,
		RetryPolicy:         &temporal.RetryPolicy{InitialInterval: 5 * time.Second, MaximumAttempts: 4},
	})
	for {
		var done bool
		err := workflow.ExecuteActivity(ctx, NextActivity, input).Get(ctx, &done)
		if err != nil {
			if temporal.IsCanceledError(err) {
				return err
			}
			if err := workflow.ExecuteActivity(ctx, UnconfirmedActivity, input).Get(ctx, nil); err != nil {
				return err
			}
			continue
		}
		if done {
			return nil
		}
	}
}

// Store is the product's run steps.
type Store interface {
	ScheduleNextBatchRunItem(ctx context.Context, organizationID, runID string) (*product.BatchRunStep, error)
	MarkBatchRunItemUnconfirmed(ctx context.Context, organizationID, runID string) error
}

// Publisher wakes and stops post workflows.
type Publisher interface {
	Start(ctx context.Context, input temporalpublishing.ScheduleInput) error
	Cancel(ctx context.Context, postID string) error
}

// Activities carries out a run's steps.
type Activities struct {
	Publisher Publisher
	Store     Store
}

// Next schedules the next item and wakes its posts. The posts are committed
// either way: the once-a-minute dispatcher starts a due post whose wakeup failed.
func (a *Activities) Next(ctx context.Context, input Input) (bool, error) {
	step, err := a.Store.ScheduleNextBatchRunItem(ctx, input.OrganizationID, input.RunID)
	if err != nil {
		return false, err
	}
	var wakeup error
	for _, postID := range step.Cancelled {
		wakeup = errors.Join(wakeup, a.Publisher.Cancel(ctx, postID))
	}
	for _, post := range step.Scheduled {
		wakeup = errors.Join(wakeup, a.Publisher.Start(ctx, temporalpublishing.ScheduleInput{
			OrganizationID: post.OrganizationID, PostID: post.ID, ScheduledFor: post.ScheduledFor,
		}))
	}
	if wakeup != nil {
		slog.WarnContext(ctx, "batch post workflows were not woken", "run", input.RunID, "error", wakeup)
	}
	return step.Done, nil
}

// Unconfirmed settles the item whose retries found no answer.
func (a *Activities) Unconfirmed(ctx context.Context, input Input) error {
	return a.Store.MarkBatchRunItemUnconfirmed(ctx, input.OrganizationID, input.RunID)
}

// Register adds the workflow and activities to a worker on TaskQueue.
func Register(w worker.Worker, a *Activities) {
	w.RegisterWorkflowWithOptions(Workflow, workflow.RegisterOptions{Name: WorkflowName})
	w.RegisterActivityWithOptions(a.Next, activity.RegisterOptions{Name: NextActivity})
	w.RegisterActivityWithOptions(a.Unconfirmed, activity.RegisterOptions{Name: UnconfirmedActivity})
}

// Client starts runs.
type Client struct{ Temporal client.Client }

// StartBatchRun starts a run's workflow; a run already started is left alone.
func (c *Client) StartBatchRun(ctx context.Context, organizationID, runID string) error {
	_, err := c.Temporal.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
		ID: "content-batch-submit-" + runID, TaskQueue: TaskQueue, WorkflowExecutionTimeout: 6 * time.Hour,
		WorkflowIDConflictPolicy: enumspb.WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING,
		WorkflowIDReusePolicy:    enumspb.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
	}, WorkflowName, Input{OrganizationID: organizationID, RunID: runID})
	var duplicate *serviceerror.WorkflowExecutionAlreadyStarted
	if errors.As(err, &duplicate) {
		return nil
	}
	return err
}
