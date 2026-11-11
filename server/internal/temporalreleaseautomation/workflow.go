// Package temporalreleaseautomation executes validated release graphs. Keep
// this v1 implementation registered while any v1 workflow remains in flight.
package temporalreleaseautomation

import (
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	automation "github.com/PlaybookMediaLLC/screenshot-studio/services/internal/releaseautomation"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

const (
	TaskQueue       = "platform-release-automation"
	WorkflowName    = "platform-release-automation-v1"
	LoadActivity    = "release-automation-load-v1"
	EnrichActivity  = "release-automation-enrich-v1"
	SelectActivity  = "release-automation-select-v1"
	NodeActivity    = "release-automation-node-v1"
	LegacyActivity  = "release-automation-legacy-v1"
	CollectActivity = "release-automation-collect-v1"
	FinishActivity  = "release-automation-finish-v1"
	// ClassifyActivity asks the AI whether an event is worth marketing and
	// returns the verdict recorded on the node receipt.
	ClassifyActivity = "release-automation-classify-v1"
	StoppedError     = "ReleaseAutomationStopped"
	PermanentError   = "ReleaseAutomationInvalid"
	// SupersededError ends a run whose deployment a newer one replaced before
	// its capture ran. It schedules the same finish activity as any failure, so
	// histories without it replay unchanged.
	SupersededError = "ReleaseAutomationSuperseded"
	// deploymentKindChange gates skipping redeploys and rollbacks, which drops
	// commands a run collected before the change would have scheduled.
	deploymentKindChange = "deployment-kind"
)

type Input struct {
	OrganizationID string `json:"organizationId"`
	RunID          string `json:"runId"`
	Attempt        int    `json:"attempt"`
}
type NodeInput struct {
	Run      Input                `json:"run"`
	NodeID   string               `json:"nodeId"`
	Decision *automation.Decision `json:"decision,omitempty"`
}
type Selection struct {
	Run       Input  `json:"run"`
	VersionID string `json:"versionId"`
}
type Finish struct {
	Run    Input  `json:"run"`
	Status string `json:"status"`
	Code   string `json:"code"`
	Reason string `json:"reason"`
}

// Workflow owns selection and graph traversal. Activities only load evidence,
// authorize, and perform one domain operation. The next node is never an
// activity/model result and never comes from repository content.
func Workflow(ctx workflow.Context, input Input) error {
	ctx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: 2 * time.Minute, RetryPolicy: &temporal.RetryPolicy{InitialInterval: time.Second, MaximumInterval: 30 * time.Second, MaximumAttempts: 4, NonRetryableErrorTypes: []string{StoppedError, PermanentError}}})
	finish := Finish{Run: input, Status: "succeeded", Reason: "Selected workflow completed."}
	err := execute(ctx, input, &finish)
	if err != nil {
		finish.Status, finish.Code, finish.Reason = "failed", "activity_failed", "An activity exhausted its retries. Completed action receipts are retained."
		if temporal.IsCanceledError(err) || ctx.Err() != nil {
			finish.Status, finish.Code, finish.Reason = "cancelled", "cancelled", "Cancellation stopped further work; completed outputs are retained."
		} else {
			var app *temporal.ApplicationError
			if temporalError(err, &app) {
				switch app.Type() {
				case StoppedError:
					finish.Status, finish.Code, finish.Reason = "cancelled", "access_revoked", "Automation was disabled or required access was revoked."
				case PermanentError:
					finish.Status, finish.Code, finish.Reason = "needs_attention", "configuration_invalid", "Required configuration or evidence is unavailable. No further actions were executed."
				case SupersededError:
					finish.Status, finish.Code, finish.Reason = "cancelled", "superseded", "A newer deployment replaced this one before its capture ran; that deployment captures for itself. Completed outputs are retained."
				}
			}
		}
	}
	finalCtx, _ := workflow.NewDisconnectedContext(ctx)
	if finalErr := workflow.ExecuteActivity(finalCtx, FinishActivity, finish).Get(finalCtx, nil); finalErr != nil {
		return finalErr
	}
	return err
}

func execute(ctx workflow.Context, input Input, finish *Finish) error {
	var loaded product.AutomationRunInput
	if err := workflow.ExecuteActivity(ctx, LoadActivity, input).Get(ctx, &loaded); err != nil {
		return err
	}
	if loaded.Mode == "legacy" {
		finish.Reason = "Sent to the Release inbox."
		return workflow.ExecuteActivity(ctx, LegacyActivity, input).Get(ctx, nil)
	}
	event := loaded.Event
	if event.Origin != "live" {
		finish.Status, finish.Reason = "skipped", "Historical events never execute marketing actions."
		return nil
	}
	if event.Family == automation.Deployed {
		var kind string
		if err := workflow.ExecuteActivity(ctx, CollectActivity, input).Get(ctx, &kind); err != nil {
			return err
		}
		// Only a new commit is a release. A redeploy or rollback was captured when
		// it was collected and starts no workflow. Earlier histories carry no kind.
		if (kind == "redeploy" || kind == "rollback") && workflow.GetVersion(ctx, deploymentKindChange, workflow.DefaultVersion, 1) == 1 {
			finish.Status, finish.Code = "skipped", kind
			finish.Reason = "A redeploy of the commit already live: pages without a capture of it were captured, and no workflow started."
			if kind == "rollback" {
				finish.Reason = "A rollback to a commit deployed here before: its pages were captured again, and no workflow started."
			}
			return nil
		}
	}
	needsFiles := false
	for _, plan := range loaded.Plans {
		needsFiles = needsFiles || usesFiles(plan.Graph)
	}
	if needsFiles && event.Family == automation.Merged && event.Fields["pr.files"].State != "available" {
		enrichCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: 5 * time.Minute, HeartbeatTimeout: 30 * time.Second, RetryPolicy: &temporal.RetryPolicy{InitialInterval: 2 * time.Second, MaximumInterval: 30 * time.Second, MaximumAttempts: 3, NonRetryableErrorTypes: []string{StoppedError, PermanentError}}})
		if err := workflow.ExecuteActivity(enrichCtx, EnrichActivity, input).Get(ctx, &event); err != nil {
			return err
		}
	}
	var selected *product.AutomationPlan
	for i := range loaded.Plans {
		plan := &loaded.Plans[i]
		if len(automation.Validate(plan.Graph)) > 0 {
			return temporal.NewNonRetryableApplicationError("Invalid pinned graph", PermanentError, nil)
		}
		decision := automation.Evaluate(plan.Graph.Qualification, event)
		if decision.Status != "evaluated" {
			finish.Status, finish.Code, finish.Reason = "needs_attention", decision.Status, decision.Reason
			return nil
		}
		if decision.Match {
			selected = plan
			break
		}
	}
	if selected == nil {
		if event.Family == automation.Merged && loaded.CollectUnmatched {
			if err := workflow.ExecuteActivity(ctx, CollectActivity, input).Get(ctx, nil); err != nil {
				return err
			}
		}
		finish.Status, finish.Code, finish.Reason = "skipped", "no_match", "No workflow matched; no release or campaign was created."
		if event.Family == automation.Merged && loaded.CollectUnmatched {
			finish.Reason += " The merged PR was held as a change under the accepted source policy."
		}
		return nil
	}
	if err := workflow.ExecuteActivity(ctx, SelectActivity, Selection{Run: input, VersionID: selected.VersionID}).Get(ctx, nil); err != nil {
		return err
	}
	// Collection preserves PR evidence even when an explicit workflow creates
	// a PR-defined release; create_release attaches only that PR's change.
	if event.Family == automation.Merged {
		if err := workflow.ExecuteActivity(ctx, CollectActivity, input).Get(ctx, nil); err != nil {
			return err
		}
	}
	for id := automation.Trigger(selected.Graph); id != ""; {
		node := automation.FindNode(selected.Graph, id)
		branch := "next"
		step := NodeInput{Run: input, NodeID: id}
		if node.Type == "condition" {
			decision := automation.Evaluate(*node.Condition, event)
			step.Decision = &decision
			if decision.Status != "evaluated" {
				if err := workflow.ExecuteActivity(ctx, NodeActivity, step).Get(ctx, nil); err != nil {
					return err
				}
				finish.Status, finish.Code, finish.Reason = "needs_attention", decision.Status, decision.Reason
				return nil
			}
			branch = "false"
			if decision.Match {
				branch = "true"
			}
		}
		// Only version 2 graphs contain AI, copy, and render nodes, so v1
		// histories replay unchanged. Receipts persist model output and
		// renders before completion, so these bounded retries never call,
		// charge, or render twice.
		paidCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: 5 * time.Minute, RetryPolicy: &temporal.RetryPolicy{InitialInterval: 5 * time.Second, MaximumInterval: time.Minute, MaximumAttempts: 3, NonRetryableErrorTypes: []string{StoppedError, PermanentError}}})
		if node.Type == "classify" {
			var verdict automation.Decision
			if err := workflow.ExecuteActivity(paidCtx, ClassifyActivity, step).Get(ctx, &verdict); err != nil {
				return err
			}
			branch = "false"
			if verdict.Match {
				branch = "true"
			}
			id = automation.Next(selected.Graph, id, branch)
			continue
		}
		nodeCtx := ctx
		if node.Type == "action" && (node.Action.Type == "generate_copy" || node.Action.Type == "render_creatives" || node.Action.Type == "render_code_visual" || node.Action.Type == "create_canvas") {
			nodeCtx = paidCtx
		}
		// Only version 3 graphs capture. The app may take minutes to serve the
		// deployed commit, so these attempts back off for about ten minutes, and
		// each one reuses a receipt that an earlier attempt left.
		if node.Type == "action" && node.Action.Type == "capture_product" {
			nodeCtx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: 3 * time.Minute, RetryPolicy: &temporal.RetryPolicy{InitialInterval: 15 * time.Second, MaximumInterval: 2 * time.Minute, MaximumAttempts: 8, NonRetryableErrorTypes: []string{StoppedError, PermanentError}}})
		}
		if err := workflow.ExecuteActivity(nodeCtx, NodeActivity, step).Get(ctx, nil); err != nil {
			return err
		}
		if node.Type == "action" && node.Action.Type == "submit_review" {
			finish.Reason = "Drafts submitted for human review. This workflow ends here; it does not approve or schedule content."
		}
		if node.Type == "end" && node.Outcome == "skipped" {
			finish.Status, finish.Reason = "skipped", "The selected branch intentionally skipped further work."
		}
		id = automation.Next(selected.Graph, id, branch)
	}
	return nil
}

func usesFiles(graph automation.Graph) bool {
	var contains func(automation.Condition) bool
	contains = func(c automation.Condition) bool {
		if c.Field == "pr.files" {
			return true
		}
		for _, child := range c.Children {
			if contains(child) {
				return true
			}
		}
		return false
	}
	if contains(graph.Qualification) {
		return true
	}
	for _, node := range graph.Nodes {
		if node.Condition != nil && contains(*node.Condition) {
			return true
		}
	}
	return false
}
