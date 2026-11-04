package temporalpublishing

import (
	"errors"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"sort"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

const (
	maxPendingChecks       = 90
	maxStatusCheckFailures = 5
	pendingCheckInterval   = 20 * time.Second
)

func PostWorkflowV2(ctx workflow.Context, input WorkflowInput) (WorkflowResult, error) {
	cancelSignal := workflow.GetSignalChannel(ctx, CancelSignalName)
	pokeSignal := workflow.GetSignalChannel(ctx, PokeSignalName)
	if waitForCancelAndDrainPoke(ctx, cancelSignal, pokeSignal, input.ScheduledFor.Sub(workflow.Now(ctx))) {
		return WorkflowResult{Outcome: OutcomeCancelled}, nil
	}

	mainCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		TaskQueue:           input.MainTaskQueue,
		StartToCloseTimeout: 10 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    2 * time.Minute,
			BackoffCoefficient: 1,
			MaximumAttempts:    3,
		},
	})
	mutationCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		TaskQueue:           input.ActivityTaskQueue,
		StartToCloseTimeout: input.ActivityTimeout,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
	})
	// Recording an outcome is idempotent and must outlast a database outage: a
	// receipt never written would leave a live post looking unpublished.
	// Replay compares activity types and IDs only, so these options are safe
	// for running workflows.
	recordCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		TaskQueue:              input.MainTaskQueue,
		StartToCloseTimeout:    10 * time.Minute,
		ScheduleToCloseTimeout: 24 * time.Hour,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    30 * time.Second,
			BackoffCoefficient: 2,
			MaximumInterval:    10 * time.Minute,
		},
	})
	checkCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		TaskQueue:           input.ActivityTaskQueue,
		StartToCloseTimeout: 2 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    10 * time.Second,
			BackoffCoefficient: 1,
			MaximumAttempts:    3,
		},
	})

	runID := workflow.GetInfo(ctx).WorkflowExecution.RunID
	for attemptNumber := 1; attemptNumber <= input.MaxAttempts; attemptNumber++ {
		drainPoke(pokeSignal)
		if receiveCancel(cancelSignal) {
			return WorkflowResult{Outcome: OutcomeCancelled}, nil
		}
		var job PreparedPublication
		if err := workflow.ExecuteActivity(mainCtx, PrepareActivityName, PrepareInput{
			PostID: input.PostID, RunID: runID,
		}).Get(ctx, &job); err != nil {
			return WorkflowResult{}, err
		}
		if !job.Ready {
			return WorkflowResult{Outcome: OutcomeSkipped}, nil
		}

		var attempt BeginResult
		if err := workflow.ExecuteActivity(mainCtx, BeginActivityName, BeginInput{
			AttemptNumber: attemptNumber, Job: job, RunID: runID,
		}).Get(ctx, &attempt); err != nil {
			return WorkflowResult{}, err
		}

		var submitted PublishResult
		if err := workflow.ExecuteActivity(mutationCtx, SubmitActivityName, SubmitInput{Job: job}).Get(ctx, &submitted); err != nil {
			return markUnknown(ctx, recordCtx, job.PostID, runID, attemptNumber, nil)
		}
		switch submitted.Outcome {
		case OutcomeRetry:
			if attemptNumber >= input.MaxAttempts {
				if err := failAttempt(ctx, recordCtx, attempt, job, runID, submitted.FailureCode, time.Time{}); err != nil {
					return WorkflowResult{}, err
				}
				return WorkflowResult{FailureCode: submitted.FailureCode, Outcome: OutcomeFailed}, nil
			}
			retryAt := workflow.Now(ctx).Add(input.RetryDelay)
			if err := failAttempt(ctx, recordCtx, attempt, job, runID, submitted.FailureCode, retryAt); err != nil {
				return WorkflowResult{}, err
			}
			if waitForCancelAndDrainPoke(ctx, cancelSignal, pokeSignal, input.RetryDelay) {
				return WorkflowResult{Outcome: OutcomeCancelled}, nil
			}
			continue
		case OutcomeFailed:
			if err := failAttempt(ctx, recordCtx, attempt, job, runID, submitted.FailureCode, time.Time{}); err != nil {
				return WorkflowResult{}, err
			}
			return WorkflowResult{FailureCode: submitted.FailureCode, Outcome: OutcomeFailed}, nil
		case OutcomeUnknown:
			return markUnknown(ctx, recordCtx, job.PostID, runID, attemptNumber, submitted.Progress)
		case OutcomePublished:
			if err := completeAttempt(ctx, recordCtx, attempt, job, runID, submitted.ProviderID, submitted.Progress); err != nil {
				return WorkflowResult{}, err
			}
			runAutoActions(ctx, input, job, submitted.ProviderID)
			return WorkflowResult{Outcome: OutcomePublished, ProviderID: submitted.ProviderID}, nil
		}

		result, err := awaitSocialConfirmation(ctx, checkCtx, recordCtx, attempt, job, runID, submitted.ProviderID)
		if err != nil {
			return WorkflowResult{}, err
		}
		return result, nil
	}
	return WorkflowResult{FailureCode: "MAX_ATTEMPTS", Outcome: OutcomeFailed}, nil
}

func awaitSocialConfirmation(
	ctx workflow.Context,
	checkCtx workflow.Context,
	recordCtx workflow.Context,
	attempt BeginResult,
	job PreparedPublication,
	runID string,
	socialPostID string,
) (WorkflowResult, error) {
	consecutiveFailures := 0
	for check := 0; check < maxPendingChecks; check++ {
		var status PublishResult
		err := workflow.ExecuteActivity(checkCtx, CheckActivityName, CheckInput{
			Job: job, ProviderID: socialPostID,
		}).Get(ctx, &status)
		if err != nil {
			consecutiveFailures++
			if consecutiveFailures >= maxStatusCheckFailures {
				return markUnknown(ctx, recordCtx, job.PostID, runID, attempt.AttemptNumber, nil)
			}
		} else {
			consecutiveFailures = 0
			switch status.Outcome {
			case OutcomePublished:
				providerID := status.ProviderID
				if providerID == "" {
					providerID = socialPostID
				}
				if err := completeAttempt(ctx, recordCtx, attempt, job, runID, providerID, nil); err != nil {
					return WorkflowResult{}, err
				}
				return WorkflowResult{Outcome: OutcomePublished, ProviderID: providerID}, nil
			case OutcomeFailed:
				if err := failAttempt(ctx, recordCtx, attempt, job, runID, status.FailureCode, time.Time{}); err != nil {
					return WorkflowResult{}, err
				}
				return WorkflowResult{FailureCode: status.FailureCode, Outcome: OutcomeFailed}, nil
			}
		}
		if check+1 < maxPendingChecks {
			if err := workflow.Sleep(ctx, pendingCheckInterval); err != nil {
				return WorkflowResult{}, err
			}
		}
	}
	return markUnknown(ctx, recordCtx, job.PostID, runID, attempt.AttemptNumber, nil)
}

func completeAttempt(ctx, activityCtx workflow.Context, attempt BeginResult, job PreparedPublication, runID, providerID string, progress *postoptions.ThreadProgress) error {
	return workflow.ExecuteActivity(activityCtx, CompleteActivityName, CompleteInput{
		AttemptID: attempt.AttemptID, Job: job, ProviderID: providerID, RunID: runID, Progress: progress,
	}).Get(ctx, nil)
}

func failAttempt(ctx, activityCtx workflow.Context, attempt BeginResult, job PreparedPublication, runID, failureCode string, retryAt time.Time) error {
	return workflow.ExecuteActivity(activityCtx, FailActivityName, FailInput{
		AttemptID: attempt.AttemptID, AttemptNumber: attempt.AttemptNumber,
		FailureCode: failureCode, Job: job, RetryAt: retryAt, RunID: runID,
	}).Get(ctx, nil)
}

func markUnknown(ctx, activityCtx workflow.Context, postID, runID string, attemptNumber int, progress *postoptions.ThreadProgress) (WorkflowResult, error) {
	err := workflow.ExecuteActivity(activityCtx, MarkUnknownActivityName, MarkUnknownInput{
		AttemptNumber: attemptNumber, PostID: postID, RunID: runID, Progress: progress,
	}).Get(ctx, nil)
	if err != nil {
		return WorkflowResult{}, err
	}
	return WorkflowResult{FailureCode: "UNKNOWN_DELIVERY", Outcome: OutcomeFailed}, nil
}

func drainPoke(signal workflow.ReceiveChannel) {
	var value PokeSignal
	for signal.ReceiveAsync(&value) {
	}
}

func waitForCancelAndDrainPoke(ctx workflow.Context, cancelSignal, pokeSignal workflow.ReceiveChannel, delay time.Duration) bool {
	if receiveCancel(cancelSignal) {
		return true
	}
	drainPoke(pokeSignal)
	if delay <= 0 {
		return false
	}
	timerCtx, cancelTimer := workflow.WithCancel(ctx)
	defer cancelTimer()
	timer := workflow.NewTimer(timerCtx, delay)
	for {
		cancelled := false
		finished := false
		selector := workflow.NewSelector(ctx)
		selector.AddFuture(timer, func(f workflow.Future) {
			_ = f.Get(ctx, nil)
			finished = true
		})
		selector.AddReceive(cancelSignal, func(channel workflow.ReceiveChannel, _ bool) {
			var value CancelSignal
			channel.Receive(ctx, &value)
			cancelled = true
			cancelTimer()
		})
		selector.AddReceive(pokeSignal, func(channel workflow.ReceiveChannel, _ bool) {
			var value PokeSignal
			channel.Receive(ctx, &value)
		})
		selector.Select(ctx)
		if cancelled || finished {
			return cancelled
		}
	}
}

// autoActionChecks are when a live post's like-gated follow-ups are tried,
// after it goes out: like counts take hours to build.
var autoActionChecks = []time.Duration{6 * time.Hour, 12 * time.Hour, 18 * time.Hour}

// runAutoActions runs a live post's follow-ups. Version 2 (RFC 025) runs
// them as receipted steps (runAutomations); version 1 (RFC 013) is kept for
// workflows that started under it: a repost and a plug reply once it has
// enough likes, tried at autoActionChecks, and a quote after
// QuoteAfterHours. Workflows from before either skip them. A follow-up
// that fails is left undone; the post is live either way.
func runAutoActions(ctx workflow.Context, input WorkflowInput, job PreparedPublication, providerID string) {
	switch workflow.GetVersion(ctx, "post-auto-actions", workflow.DefaultVersion, 2) {
	case workflow.DefaultVersion:
		return
	case 2:
		runAutomations(ctx, input, job, providerID)
		return
	}
	actions := job.AutoActions
	if actions == nil || actions.Empty() {
		return
	}
	actionCtx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		TaskQueue:           input.ActivityTaskQueue,
		StartToCloseTimeout: 2 * time.Minute,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 2},
	})
	repost, plug, quote := actions.RepostAtLikes > 0, actions.PlugAtLikes > 0, actions.QuoteAfterHours > 0
	quoteAt := time.Duration(actions.QuoteAfterHours) * time.Hour
	waits := append([]time.Duration{}, autoActionChecks...)
	if quote {
		waits = append(waits, quoteAt)
	}
	sort.Slice(waits, func(i, j int) bool { return waits[i] < waits[j] })
	started := workflow.Now(ctx)
	last := len(autoActionChecks) - 1
	for index, wait := range waits {
		if !repost && !plug && !quote {
			return
		}
		if index > 0 && waits[index-1] == wait {
			continue
		}
		if err := workflow.Sleep(ctx, started.Add(wait).Sub(workflow.Now(ctx))); err != nil {
			return
		}
		check := wait <= autoActionChecks[last] && containsDuration(autoActionChecks, wait)
		var done AutoActionsResult
		err := workflow.ExecuteActivity(actionCtx, AutoActionsActivityName, AutoActionsInput{
			Job: job, ProviderID: providerID,
			Repost: repost && check, Plug: plug && check, Quote: quote && wait >= quoteAt,
		}).Get(ctx, &done)
		if err != nil {
			var failure *temporal.ApplicationError
			if errors.As(err, &failure) && failure.Type() == FailureUnknownDelivery {
				return
			}
			continue
		}
		repost = repost && !done.Reposted
		plug = plug && !done.Plugged
		quote = quote && !done.Quoted
	}
}

func containsDuration(list []time.Duration, value time.Duration) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}
