package temporalonboarding

import (
	"errors"
	"slices"
	"time"

	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/onboarding"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
)

// Error types activities raise that must not be retried.
const (
	// ErrRefused is a page or call the platform will never make.
	ErrRefused = "OnboardingRefused"
	// ErrRevoked is a starter who lost access: the run's results are discarded.
	ErrRevoked = "OnboardingAccessRevoked"
	// ErrBudget is a model call the run's token budget cannot pay for.
	ErrBudget = "OnboardingBudget"
)

// retry is two retries with backoff, then the caller moves on.
func retry() *temporal.RetryPolicy {
	return &temporal.RetryPolicy{InitialInterval: 2 * time.Second, BackoffCoefficient: 2, MaximumInterval: 30 * time.Second,
		MaximumAttempts: 3, NonRetryableErrorTypes: []string{ErrRefused, ErrRevoked, ErrBudget}}
}

func activityContext(ctx workflow.Context, startToClose, heartbeat time.Duration) workflow.Context {
	return workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: startToClose, HeartbeatTimeout: heartbeat, RetryPolicy: retry()})
}

// Workflow is the parent, one per workspace (ID onboarding-<workspaceId>). It
// runs the pipeline as a child with the 15-minute execution timeout, answers
// the progress query, forwards a cancel, and records the outcome: a deadline
// is partial, not failed, and a cancel keeps what was extracted.
func Workflow(ctx workflow.Context, input Input) (Progress, error) {
	progress := Progress{CompletedStages: []string{onboarding.StageFastPath}, PagesDiscovered: len(pages(input)), Percent: onboarding.ProgressFastPath,
		RunID: input.RunID, Stage: onboarding.StageCrawl, ModelCostMicros: input.ModelCostMicros, TokenBudget: input.TokenBudget, TokensUsed: input.TokensUsed}
	if err := workflow.SetQueryHandler(ctx, ProgressQuery, func() (Progress, error) { return progress, nil }); err != nil {
		return progress, err
	}
	childCtx, cancelChild := workflow.WithCancel(ctx)
	childCtx = workflow.WithChildOptions(childCtx, workflow.ChildWorkflowOptions{
		WorkflowID:               PipelineID(workflow.GetInfo(ctx).WorkflowExecution.ID, input.RunID),
		WorkflowExecutionTimeout: Deadline, WorkflowRunTimeout: Deadline,
		ParentClosePolicy: enumspb.PARENT_CLOSE_POLICY_TERMINATE,
	})
	child := workflow.ExecuteChildWorkflow(childCtx, PipelineWorkflowName, input)
	progressSignals := workflow.GetSignalChannel(ctx, ProgressSignal)
	cancelSignals := workflow.GetSignalChannel(ctx, CancelSignal)
	merge := func(next Progress) {
		if next.RunID == input.RunID {
			next.Percent = max(progress.Percent, next.Percent)
			progress = next
		}
	}
	var outcome Outcome
	var childErr error
	cancelled, done := false, false
	for !done {
		selector := workflow.NewSelector(ctx)
		selector.AddFuture(child, func(f workflow.Future) { childErr, done = f.Get(ctx, &outcome), true })
		selector.AddReceive(progressSignals, func(channel workflow.ReceiveChannel, _ bool) {
			var next Progress
			channel.Receive(ctx, &next)
			merge(next)
		})
		selector.AddReceive(cancelSignals, func(channel workflow.ReceiveChannel, _ bool) {
			channel.Receive(ctx, nil)
			cancelled = true
			cancelChild()
		})
		if !cancelled {
			// The workflow itself was cancelled: treat it as the cancel signal.
			// Once cancelled, Done stays ready, so it is no longer selected.
			selector.AddReceive(ctx.Done(), func(workflow.ReceiveChannel, bool) {
				cancelled = true
				cancelChild()
			})
		}
		selector.Select(ctx)
	}
	for {
		var next Progress
		if !progressSignals.ReceiveAsync(&next) {
			break
		}
		merge(next)
	}
	finish := decide(input, progress, outcome, childErr, cancelled)
	finishCtx, _ := workflow.NewDisconnectedContext(ctx)
	finishCtx = activityContext(finishCtx, 30*time.Second, 0)
	if err := workflow.ExecuteActivity(finishCtx, FinishRunActivity, input, finish).Get(finishCtx, nil); err != nil {
		workflow.GetLogger(ctx).Error("onboarding run outcome not recorded", "runId", input.RunID)
	}
	return finish.Progress, nil
}

// decide maps how the pipeline ended to the run's terminal state.
func decide(input Input, progress Progress, outcome Outcome, childErr error, cancelled bool) Finish {
	finish := Finish{Progress: progress, RunID: input.RunID}
	var application *temporal.ApplicationError
	switch {
	case cancelled:
		finish.Status = product.OnboardingCancelled
	case childErr == nil && outcome.Partial:
		finish.Status, finish.ErrorCode = product.OnboardingPartial, outcome.Reason
		finish.Message = "The run stopped at its " + map[string]string{"token_budget": "token budget", "page_limit": "page limit"}[outcome.Reason] + "; what it read is kept."
	case childErr == nil:
		finish.Status = product.OnboardingCompleted
		finish.Progress.Percent, finish.Progress.Stage = onboarding.ProgressDone, onboarding.StageDone
	case temporal.IsTimeoutError(childErr):
		finish.Status, finish.ErrorCode = product.OnboardingPartial, "deadline"
		finish.Message = "The run reached its 15-minute limit; what it read is kept."
	case errors.As(childErr, &application) && application.Type() == ErrRevoked:
		finish.Status, finish.ErrorCode = product.OnboardingFailed, "access_revoked"
		finish.Message = "Whoever started the run can no longer change this workspace, so its results were discarded."
	case progress.PagesProcessed > 0 || len(progress.CompletedStages) > 1:
		// A run fails only when it produced nothing; this one produced something.
		finish.Status, finish.ErrorCode = product.OnboardingPartial, "stage_failed"
		finish.Message = "A stage failed after retries; what the run read is kept."
	default:
		finish.Status, finish.ErrorCode = product.OnboardingFailed, "stage_failed"
		finish.Message = "The background read failed. Your draft is saved; run it again later."
	}
	return finish
}

// pages is the crawl list, capped at the plan's page limit.
func pages(input Input) []string {
	return input.Pages[:min(len(input.Pages), max(input.PageLimit, 0))]
}

// tracker keeps the pipeline's progress, raises it monotonically, and
// reports each change to the parent and the run row.
type tracker struct {
	ctx      workflow.Context
	input    Input
	progress Progress
}

func (t *tracker) report(stage string, percent int, complete bool) {
	t.progress.Stage = stage
	t.progress.Percent = max(t.progress.Percent, percent)
	if complete && !slices.Contains(t.progress.CompletedStages, stage) {
		t.progress.CompletedStages = append(slices.Clone(t.progress.CompletedStages), stage)
	}
	snapshot := t.progress
	if parent := workflow.GetInfo(t.ctx).ParentWorkflowExecution; parent != nil {
		_ = workflow.SignalExternalWorkflow(t.ctx, parent.ID, "", ProgressSignal, snapshot).Get(t.ctx, nil)
	}
	reportCtx := activityContext(t.ctx, 30*time.Second, 0)
	_ = workflow.ExecuteActivity(reportCtx, ReportProgressActivity, t.input, snapshot).Get(reportCtx, nil)
}

// affordable reports whether one more model call fits the token budget.
func (t *tracker) affordable() bool {
	return t.progress.TokensUsed+draftTokenEstimate <= t.input.TokenBudget
}

// Pipeline is the child: crawl, extract, enrich, derive the ICP, seed the
// brand and surfaces. A stage that would exceed the token budget stops the
// run partial. Page content never decides what runs next: only counts and
// budgets do, so injected text cannot change the control flow.
func Pipeline(ctx workflow.Context, input Input) (Outcome, error) {
	crawlList := pages(input)
	t := &tracker{ctx: ctx, input: input, progress: Progress{CompletedStages: []string{onboarding.StageFastPath}, PagesDiscovered: len(crawlList),
		Percent: onboarding.ProgressFastPath, RunID: input.RunID, Stage: onboarding.StageCrawl, ModelCostMicros: input.ModelCostMicros, TokenBudget: input.TokenBudget, TokensUsed: input.TokensUsed}}
	crawlCtx := activityContext(ctx, 45*time.Second, 15*time.Second)
	batchProgress := workflow.GetVersion(ctx, "batch-crawl-progress", workflow.DefaultVersion, 1) == 1
	var changed []string
	for i, page := range crawlList {
		var result PageOutcome
		err := workflow.ExecuteActivity(crawlCtx, CrawlPageActivity, input, page).Get(ctx, &result)
		if err != nil {
			if ctx.Err() != nil || isType(err, ErrRevoked) {
				return Outcome{}, err
			}
			// Retried twice; skip the page and keep going.
			result = PageOutcome{Skipped: true, URL: page}
		}
		t.progress.PagesProcessed++
		if result.Skipped {
			t.progress.PagesSkipped++
		}
		if result.Changed {
			changed = append(changed, page)
		}
		if !batchProgress || t.progress.PagesProcessed == 1 || (i < len(crawlList)-1 && t.progress.PagesProcessed%3 == 0) {
			t.report(onboarding.StageCrawl, onboarding.ProgressFastPath+35*t.progress.PagesProcessed/max(len(crawlList), 1), false)
		}
		if result.Fetched && i < len(crawlList)-1 {
			if err := workflow.Sleep(ctx, hostInterval); err != nil {
				return Outcome{}, err
			}
		}
	}
	t.report(onboarding.StageCrawl, 55, true)

	modelCtx := activityContext(ctx, 2*time.Minute, 0)
	for start := 0; start < len(changed); start += batchPages {
		if !t.affordable() {
			return Outcome{Partial: true, Reason: "token_budget"}, nil
		}
		var result ModelOutcome
		batch := BatchInput{Run: input, URLs: changed[start:min(start+batchPages, len(changed))]}
		if err := workflow.ExecuteActivity(modelCtx, EnrichProfileActivity, batch).Get(ctx, &result); err != nil {
			if ctx.Err() != nil || isType(err, ErrRevoked) {
				return Outcome{}, err
			}
			// The batch failed its retries; the others still count.
		}
		t.progress.TokensUsed, t.progress.ModelCostMicros = t.progress.TokensUsed+result.Tokens, t.progress.ModelCostMicros+result.CostMicros
		t.report(onboarding.StageClassify, 55+20*min(start+batchPages, len(changed))/len(changed), false)
	}
	t.report(onboarding.StageClassify, 75, true)

	var enriched EnrichOutcome
	if err := workflow.ExecuteActivity(modelCtx, EnrichActivity, input).Get(ctx, &enriched); err != nil && (ctx.Err() != nil || isType(err, ErrRevoked)) {
		return Outcome{}, err
	}
	t.progress.EnrichmentCostMicros += enriched.CostMicros
	t.report(onboarding.StageEnrich, 85, true)

	if len(changed) > 0 || enriched.Changed {
		if !t.affordable() {
			return Outcome{Partial: true, Reason: "token_budget"}, nil
		}
		var result ModelOutcome
		if err := workflow.ExecuteActivity(modelCtx, DeriveICPActivity, input).Get(ctx, &result); err != nil && (ctx.Err() != nil || isType(err, ErrRevoked)) {
			return Outcome{}, err
		}
		t.progress.TokensUsed, t.progress.ModelCostMicros = t.progress.TokensUsed+result.Tokens, t.progress.ModelCostMicros+result.CostMicros
	}
	t.report(onboarding.StageICP, 95, true)

	seedCtx := activityContext(ctx, time.Minute, 0)
	if err := workflow.ExecuteActivity(seedCtx, SeedBrandActivity, input).Get(ctx, nil); err != nil && (ctx.Err() != nil || isType(err, ErrRevoked)) {
		return Outcome{}, err
	}
	t.report(onboarding.StageBrand, 98, true)
	if input.SeedSurfaces {
		if err := workflow.ExecuteActivity(seedCtx, SeedSurfacesActivity, input).Get(ctx, nil); err != nil && (ctx.Err() != nil || isType(err, ErrRevoked)) {
			return Outcome{}, err
		}
	}
	t.report(onboarding.StageSurfaces, onboarding.ProgressDone, true)
	return Outcome{}, nil
}

// batchPages is how many changed pages one extraction call reads.
const batchPages = 6

func isType(err error, kind string) bool {
	var application *temporal.ApplicationError
	return errors.As(err, &application) && application.Type() == kind
}
