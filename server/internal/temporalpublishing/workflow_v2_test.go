package temporalpublishing

import (
	"context"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/postoptions"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
)

func TestPostWorkflowV2ConfirmsAcceptedPostWithoutRepeatingMutation(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	submitCalls := 0
	checkCalls := 0
	completedProviderID := ""
	env.RegisterActivityWithOptions(func(context.Context, PrepareInput) (PreparedPublication, error) {
		return PreparedPublication{PostID: "post-1", OrganizationID: "org-1", Ready: true}, nil
	}, activity.RegisterOptions{Name: PrepareActivityName})
	env.RegisterActivityWithOptions(func(_ context.Context, input BeginInput) (BeginResult, error) {
		return BeginResult{AttemptID: "attempt-1", AttemptNumber: input.AttemptNumber}, nil
	}, activity.RegisterOptions{Name: BeginActivityName})
	env.RegisterActivityWithOptions(func(context.Context, SubmitInput) (PublishResult, error) {
		submitCalls++
		return PublishResult{Outcome: OutcomePending, ProviderID: "social-post-1"}, nil
	}, activity.RegisterOptions{Name: SubmitActivityName})
	env.RegisterActivityWithOptions(func(context.Context, CheckInput) (PublishResult, error) {
		checkCalls++
		if checkCalls == 1 {
			return PublishResult{Outcome: OutcomePending}, nil
		}
		return PublishResult{Outcome: OutcomePublished, ProviderID: "provider-post-1"}, nil
	}, activity.RegisterOptions{Name: CheckActivityName})
	env.RegisterActivityWithOptions(func(_ context.Context, input CompleteInput) error {
		completedProviderID = input.ProviderID
		return nil
	}, activity.RegisterOptions{Name: CompleteActivityName})
	env.ExecuteWorkflow(PostWorkflowV2, WorkflowInput{
		ActivityTaskQueue: DefaultActivityQueue, ActivityTimeout: time.Minute,
		MainTaskQueue: DefaultWorkflowQueue, MaxAttempts: 3, PostID: "post-1",
		RetryDelay: time.Hour, ScheduledFor: time.Now().Add(time.Hour),
	})
	if err := env.GetWorkflowError(); err != nil {
		t.Fatal(err)
	}
	var result WorkflowResult
	if err := env.GetWorkflowResult(&result); err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomePublished || result.ProviderID != "provider-post-1" || submitCalls != 1 || checkCalls != 2 || completedProviderID != "provider-post-1" {
		t.Fatalf("result=%#v submit=%d checks=%d completed=%q", result, submitCalls, checkCalls, completedProviderID)
	}
}

func TestPostWorkflowV2CompletesDirectReceiptWithoutSecondPostPoll(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	submissions := 0
	completedID := ""
	recordCalls := 0
	progress := &postoptions.ThreadProgress{Publication: &postoptions.PublicationReceipt{RemoteID: "remote-post-1", URL: "https://www.youtube.com/watch?v=remote-post-1"}}
	env.RegisterActivityWithOptions(func(context.Context, PrepareInput) (PreparedPublication, error) {
		return PreparedPublication{PostID: "post-1", OrganizationID: "org-1", Ready: true}, nil
	}, activity.RegisterOptions{Name: PrepareActivityName})
	env.RegisterActivityWithOptions(func(context.Context, BeginInput) (BeginResult, error) {
		return BeginResult{AttemptID: "attempt-1", AttemptNumber: 1}, nil
	}, activity.RegisterOptions{Name: BeginActivityName})
	env.RegisterActivityWithOptions(func(context.Context, SubmitInput) (PublishResult, error) {
		submissions++
		return PublishResult{Outcome: OutcomePublished, ProviderID: "remote-post-1", Progress: progress}, nil
	}, activity.RegisterOptions{Name: SubmitActivityName})
	env.RegisterActivityWithOptions(func(_ context.Context, input CompleteInput) error {
		recordCalls++
		if input.Progress == nil || input.Progress.Publication.URL != progress.Publication.URL {
			t.Fatal("receipt lost from durable outcome")
		}
		if recordCalls == 1 {
			return context.DeadlineExceeded
		}
		completedID = input.ProviderID
		return nil
	}, activity.RegisterOptions{Name: CompleteActivityName})
	env.ExecuteWorkflow(PostWorkflowV2, WorkflowInput{
		ActivityTaskQueue: DefaultActivityQueue, ActivityTimeout: time.Minute,
		MainTaskQueue: DefaultWorkflowQueue, MaxAttempts: 3, PostID: "post-1",
		RetryDelay: time.Hour, ScheduledFor: time.Now(),
	})
	if err := env.GetWorkflowError(); err != nil {
		t.Fatal(err)
	}
	var result WorkflowResult
	if err := env.GetWorkflowResult(&result); err != nil || result.Outcome != OutcomePublished || result.ProviderID != "remote-post-1" || submissions != 1 || recordCalls != 2 || completedID != "remote-post-1" {
		t.Fatalf("result=%#v submit=%d completed=%q err=%v", result, submissions, completedID, err)
	}
}

func TestPostWorkflowV2MarksTimedOutMutationUnknown(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	markedUnknown := false
	env.RegisterActivityWithOptions(func(context.Context, PrepareInput) (PreparedPublication, error) {
		return PreparedPublication{PostID: "post-1", OrganizationID: "org-1", Ready: true}, nil
	}, activity.RegisterOptions{Name: PrepareActivityName})
	env.RegisterActivityWithOptions(func(_ context.Context, input BeginInput) (BeginResult, error) {
		return BeginResult{AttemptID: "attempt-1", AttemptNumber: input.AttemptNumber}, nil
	}, activity.RegisterOptions{Name: BeginActivityName})
	env.RegisterActivityWithOptions(func(context.Context, SubmitInput) (PublishResult, error) {
		return PublishResult{}, context.DeadlineExceeded
	}, activity.RegisterOptions{Name: SubmitActivityName})
	env.RegisterActivityWithOptions(func(context.Context, MarkUnknownInput) error {
		markedUnknown = true
		return nil
	}, activity.RegisterOptions{Name: MarkUnknownActivityName})
	env.ExecuteWorkflow(PostWorkflowV2, WorkflowInput{
		ActivityTaskQueue: DefaultActivityQueue, ActivityTimeout: time.Minute,
		MainTaskQueue: DefaultWorkflowQueue, MaxAttempts: 3, PostID: "post-1",
		RetryDelay: time.Hour, ScheduledFor: time.Now(),
	})
	if err := env.GetWorkflowError(); err != nil {
		t.Fatal(err)
	}
	var result WorkflowResult
	if err := env.GetWorkflowResult(&result); err != nil {
		t.Fatal(err)
	}
	if !markedUnknown || result.Outcome != OutcomeFailed || result.FailureCode != "UNKNOWN_DELIVERY" {
		t.Fatalf("result=%#v markedUnknown=%v", result, markedUnknown)
	}
}

func TestPostWorkflowV2StopsAfterLastRateLimitAttempt(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	submitCalls := 0
	failures := make([]FailInput, 0, 3)
	env.RegisterActivityWithOptions(func(context.Context, PrepareInput) (PreparedPublication, error) {
		return PreparedPublication{PostID: "post-1", OrganizationID: "org-1", Ready: true}, nil
	}, activity.RegisterOptions{Name: PrepareActivityName})
	env.RegisterActivityWithOptions(func(_ context.Context, input BeginInput) (BeginResult, error) {
		return BeginResult{AttemptID: "attempt", AttemptNumber: input.AttemptNumber}, nil
	}, activity.RegisterOptions{Name: BeginActivityName})
	env.RegisterActivityWithOptions(func(context.Context, SubmitInput) (PublishResult, error) {
		submitCalls++
		return PublishResult{FailureCode: "429", Outcome: OutcomeRetry}, nil
	}, activity.RegisterOptions{Name: SubmitActivityName})
	env.RegisterActivityWithOptions(func(_ context.Context, input FailInput) error {
		failures = append(failures, input)
		return nil
	}, activity.RegisterOptions{Name: FailActivityName})
	env.ExecuteWorkflow(PostWorkflowV2, WorkflowInput{
		ActivityTaskQueue: DefaultActivityQueue, ActivityTimeout: time.Minute,
		MainTaskQueue: DefaultWorkflowQueue, MaxAttempts: 3, PostID: "post-1",
		RetryDelay: time.Hour, ScheduledFor: time.Now(),
	})
	if err := env.GetWorkflowError(); err != nil {
		t.Fatal(err)
	}
	var result WorkflowResult
	if err := env.GetWorkflowResult(&result); err != nil {
		t.Fatal(err)
	}
	if submitCalls != 3 || len(failures) != 3 || !failures[2].RetryAt.IsZero() || result.Outcome != OutcomeFailed || result.FailureCode != "429" {
		t.Fatalf("result=%#v submit=%d failures=%#v", result, submitCalls, failures)
	}
}

// A provider's retry guidance lengthens the durable wait, up to the late
// window; shorter guidance never shortens the configured delay.
func TestPostWorkflowV2WaitsForTheProviderRetryGuidance(t *testing.T) {
	for _, tc := range []struct {
		name              string
		retryAfter, delay time.Duration
	}{
		{"provider asks for longer", 20 * time.Minute, 20 * time.Minute},
		{"provider asks for less", time.Second, 5 * time.Minute},
		{"provider asks within the window", 50 * time.Minute, 50 * time.Minute},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var suite testsuite.WorkflowTestSuite
			env := suite.NewTestWorkflowEnvironment()
			submitCalls := 0
			var failures []FailInput
			var submitted []time.Time
			env.RegisterActivityWithOptions(func(context.Context, PrepareInput) (PreparedPublication, error) {
				return PreparedPublication{PostID: "post-1", OrganizationID: "org-1", Ready: true}, nil
			}, activity.RegisterOptions{Name: PrepareActivityName})
			env.RegisterActivityWithOptions(func(_ context.Context, input BeginInput) (BeginResult, error) {
				return BeginResult{AttemptID: "attempt", AttemptNumber: input.AttemptNumber}, nil
			}, activity.RegisterOptions{Name: BeginActivityName})
			env.RegisterActivityWithOptions(func(context.Context, SubmitInput) (PublishResult, error) {
				submitCalls++
				submitted = append(submitted, env.Now())
				if submitCalls == 1 {
					return PublishResult{FailureCode: "429", Outcome: OutcomeRetry, RetryAfter: tc.retryAfter}, nil
				}
				return PublishResult{Outcome: OutcomePublished, ProviderID: "remote-1"}, nil
			}, activity.RegisterOptions{Name: SubmitActivityName})
			env.RegisterActivityWithOptions(func(_ context.Context, input FailInput) error {
				failures = append(failures, input)
				return nil
			}, activity.RegisterOptions{Name: FailActivityName})
			env.RegisterActivityWithOptions(func(context.Context, CompleteInput) error { return nil },
				activity.RegisterOptions{Name: CompleteActivityName})
			env.ExecuteWorkflow(PostWorkflowV2, WorkflowInput{
				ActivityTaskQueue: DefaultActivityQueue, ActivityTimeout: time.Minute,
				MainTaskQueue: DefaultWorkflowQueue, MaxAttempts: 3, PostID: "post-1",
				RetryDelay: 5 * time.Minute, ScheduledFor: time.Now(),
			})
			var result WorkflowResult
			if err := env.GetWorkflowResult(&result); err != nil {
				t.Fatal(err)
			}
			if result.Outcome != OutcomePublished || submitCalls != 2 || len(failures) != 1 {
				t.Fatalf("result=%#v submit=%d failures=%d", result, submitCalls, len(failures))
			}
			if waited := submitted[1].Sub(submitted[0]); waited < tc.delay || waited > tc.delay+time.Minute {
				t.Fatalf("waited %v between attempts, want %v", waited, tc.delay)
			}
		})
	}
}

// A provider that asks to wait past the late window fails the post now with
// its rate-limit reason instead of publishing it hours after its moment.
func TestPostWorkflowV2FailsARetryThatWouldMissTheLateWindow(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	submitCalls := 0
	var failures []FailInput
	env.RegisterActivityWithOptions(func(context.Context, PrepareInput) (PreparedPublication, error) {
		return PreparedPublication{PostID: "post-1", OrganizationID: "org-1", Ready: true}, nil
	}, activity.RegisterOptions{Name: PrepareActivityName})
	env.RegisterActivityWithOptions(func(_ context.Context, input BeginInput) (BeginResult, error) {
		return BeginResult{AttemptID: "attempt", AttemptNumber: input.AttemptNumber}, nil
	}, activity.RegisterOptions{Name: BeginActivityName})
	env.RegisterActivityWithOptions(func(context.Context, SubmitInput) (PublishResult, error) {
		submitCalls++
		return PublishResult{FailureCode: "429", Outcome: OutcomeRetry, RetryAfter: 3 * time.Hour, ProviderMessage: "slow down"}, nil
	}, activity.RegisterOptions{Name: SubmitActivityName})
	env.RegisterActivityWithOptions(func(_ context.Context, input FailInput) error {
		failures = append(failures, input)
		return nil
	}, activity.RegisterOptions{Name: FailActivityName})
	env.ExecuteWorkflow(PostWorkflowV2, WorkflowInput{
		ActivityTaskQueue: DefaultActivityQueue, ActivityTimeout: time.Minute,
		MainTaskQueue: DefaultWorkflowQueue, MaxAttempts: 3, PostID: "post-1",
		RetryDelay: 5 * time.Minute, ScheduledFor: time.Now(),
	})
	var result WorkflowResult
	if err := env.GetWorkflowResult(&result); err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeFailed || result.FailureCode != "429" || submitCalls != 1 || len(failures) != 1 ||
		!failures[0].RetryAt.IsZero() || failures[0].ProviderMessage != "slow down" {
		t.Fatalf("result=%#v submit=%d failures=%#v", result, submitCalls, failures)
	}
}

// A live post's follow-ups run as planned: each step at its time, and a key
// settles at its first settled step, so its later checks do not run.
func TestPostWorkflowV2RunsAutomationsAfterPublishing(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterActivityWithOptions(func(context.Context, PrepareInput) (PreparedPublication, error) {
		return PreparedPublication{PostID: "post-1", OrganizationID: "org-1", Ready: true,
			AutoActions: &postoptions.AutoActions{PlugAtLikes: 10, PlugText: "Get the guide"}}, nil
	}, activity.RegisterOptions{Name: PrepareActivityName})
	env.RegisterActivityWithOptions(func(context.Context, BeginInput) (BeginResult, error) {
		return BeginResult{AttemptID: "attempt-1", AttemptNumber: 1}, nil
	}, activity.RegisterOptions{Name: BeginActivityName})
	env.RegisterActivityWithOptions(func(context.Context, SubmitInput) (PublishResult, error) {
		return PublishResult{Outcome: OutcomePublished, ProviderID: "remote-post-1"}, nil
	}, activity.RegisterOptions{Name: SubmitActivityName})
	env.RegisterActivityWithOptions(func(context.Context, CompleteInput) error { return nil },
		activity.RegisterOptions{Name: CompleteActivityName})
	var published time.Time
	env.RegisterActivityWithOptions(func(_ context.Context, input PlanAutomationsInput) ([]AutomationStep, error) {
		published = input.PublishedAt
		at := input.PublishedAt
		return []AutomationStep{
			{At: at.Add(15 * time.Minute), Key: "plug", Kind: AutomationPlug},
			{At: at.Add(30 * time.Minute), Key: "plug", Kind: AutomationPlug},
			{At: at.Add(45 * time.Minute), Final: true, Key: "plug", Kind: AutomationPlug},
			{At: at.Add(6 * time.Hour), Key: "retweet:0", Kind: AutomationRetweet},
		}, nil
	}, activity.RegisterOptions{Name: PlanAutomationsActivityName})
	type call struct {
		after time.Duration
		key   string
	}
	var calls []call
	env.RegisterActivityWithOptions(func(ctx context.Context, input AutomationInput) (AutomationResult, error) {
		calls = append(calls, call{env.Now().Sub(published).Round(time.Minute), input.Step.Key})
		// The plug's threshold is met at its second check.
		plugChecks := 0
		for _, item := range calls {
			if item.key == "plug" {
				plugChecks++
			}
		}
		return AutomationResult{Settled: input.Step.Key != "plug" || plugChecks >= 2}, nil
	}, activity.RegisterOptions{Name: RunAutomationActivityName})
	env.ExecuteWorkflow(PostWorkflowV2, WorkflowInput{
		ActivityTaskQueue: DefaultActivityQueue, ActivityTimeout: time.Minute,
		MainTaskQueue: DefaultWorkflowQueue, MaxAttempts: 3, PostID: "post-1",
		RetryDelay: time.Hour, ScheduledFor: time.Now(),
	})
	if err := env.GetWorkflowError(); err != nil {
		t.Fatal(err)
	}
	want := []call{{15 * time.Minute, "plug"}, {30 * time.Minute, "plug"}, {6 * time.Hour, "retweet:0"}}
	if len(calls) != len(want) {
		t.Fatalf("calls=%+v", calls)
	}
	for index := range want {
		if calls[index] != want[index] {
			t.Fatalf("calls=%+v", calls)
		}
	}
}
