package temporalreleaseautomation

import (
	"context"
	"errors"
	"fmt"
	"time"

	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

type Client struct{ Temporal client.Client }

func workflowID(base string, attempt int) string {
	if attempt == 0 {
		return base
	}
	return fmt.Sprintf("%s-recovery-%d", base, attempt)
}

func StartOptions(runID string, attempt int) client.StartWorkflowOptions {
	return client.StartWorkflowOptions{ID: workflowID("release-automation-"+runID, attempt), TaskQueue: TaskQueue, WorkflowExecutionTimeout: 24 * time.Hour,
		WorkflowIDConflictPolicy: enumspb.WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING, WorkflowIDReusePolicy: enumspb.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE}
}

// Start recovers both open and closed executions after a lost dispatch ack.
// An explicit recovery uses another execution ID but retains the logical run
// and every node/action key in Postgres.
func (c *Client) Start(ctx context.Context, org, runID string, attempt int) (string, error) {
	options := StartOptions(runID, attempt)
	handle, err := c.Temporal.ExecuteWorkflow(ctx, options, WorkflowName, Input{OrganizationID: org, RunID: runID, Attempt: attempt})
	var duplicate *serviceerror.WorkflowExecutionAlreadyStarted
	if errors.As(err, &duplicate) {
		return duplicate.RunId, nil
	}
	if err != nil {
		return "", err
	}
	return handle.GetRunID(), nil
}

func (c *Client) Cancel(ctx context.Context, base string, attempt int) error {
	err := c.Temporal.CancelWorkflow(ctx, workflowID(base, attempt), "")
	var missing *serviceerror.NotFound
	if errors.As(err, &missing) {
		return nil
	}
	return err
}

func (c *Client) startKit(ctx context.Context, id, name string, input KitInput) error {
	_, err := c.Temporal.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
		ID:                       id,
		TaskQueue:                TaskQueue,
		WorkflowExecutionTimeout: 15 * time.Minute,
		WorkflowIDConflictPolicy: enumspb.WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING,
		WorkflowIDReusePolicy:    enumspb.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE_FAILED_ONLY,
	}, name, input)
	var duplicate *serviceerror.WorkflowExecutionAlreadyStarted
	if errors.As(err, &duplicate) {
		return nil
	}
	return err
}

// StartKitPrepare launches a durable workflow to prepare a release kit revision
// off the global outbox loop.
func (c *Client) StartKitPrepare(ctx context.Context, organizationID, revisionID string) error {
	return c.startKit(ctx, "release-kit-prepare-"+revisionID, KitPrepareWorkflowName, KitInput{
		OrganizationID: organizationID,
		ID:             revisionID,
	})
}

// StartKitExport launches a durable workflow to assemble a release kit export
// bundle off the global outbox loop.
func (c *Client) StartKitExport(ctx context.Context, organizationID, exportID string) error {
	return c.startKit(ctx, "release-kit-export-"+exportID, KitExportWorkflowName, KitInput{
		OrganizationID: organizationID,
		ID:             exportID,
	})
}

func Register(w worker.Worker, a *Activities) {
	w.RegisterWorkflowWithOptions(Workflow, workflow.RegisterOptions{Name: WorkflowName})
	w.RegisterWorkflowWithOptions(KitPrepareWorkflow, workflow.RegisterOptions{Name: KitPrepareWorkflowName})
	w.RegisterWorkflowWithOptions(KitExportWorkflow, workflow.RegisterOptions{Name: KitExportWorkflowName})
	w.RegisterActivityWithOptions(a.Load, activity.RegisterOptions{Name: LoadActivity})
	w.RegisterActivityWithOptions(a.Enrich, activity.RegisterOptions{Name: EnrichActivity})
	w.RegisterActivityWithOptions(a.Select, activity.RegisterOptions{Name: SelectActivity})
	w.RegisterActivityWithOptions(a.Node, activity.RegisterOptions{Name: NodeActivity})
	w.RegisterActivityWithOptions(a.Legacy, activity.RegisterOptions{Name: LegacyActivity})
	w.RegisterActivityWithOptions(a.Collect, activity.RegisterOptions{Name: CollectActivity})
	w.RegisterActivityWithOptions(a.Finish, activity.RegisterOptions{Name: FinishActivity})
	w.RegisterActivityWithOptions(a.Classify, activity.RegisterOptions{Name: ClassifyActivity})
	w.RegisterActivityWithOptions(a.PrepareKit, activity.RegisterOptions{Name: KitPrepareActivity})
	w.RegisterActivityWithOptions(a.ExportKit, activity.RegisterOptions{Name: KitExportActivity})
}
