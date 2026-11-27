package temporalpublishing

import (
	"context"
	"errors"
	"testing"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"
)

func TestMissingPostWorkflowRunsImmediatelyAndHourly(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	calls := 0
	env.RegisterActivityWithOptions(func(context.Context) (int, error) {
		calls++
		return 0, nil
	}, activity.RegisterOptions{Name: RecoverActivityName})
	env.RegisterDelayedCallback(env.CancelWorkflow, 2*time.Hour+time.Minute)
	env.ExecuteWorkflow(MissingPostWorkflow)
	if calls != 3 {
		t.Fatalf("recovery calls = %d, want 3", calls)
	}
}

func TestMissingPostWorkflowContinuesAsNewAndSurvivesErrors(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	calls := 0
	env.RegisterActivityWithOptions(func(context.Context) (int, error) {
		calls++
		if calls <= 3 {
			// Exhaust all 3 activity retry attempts on the first iteration.
			return 0, errors.New("transient database blip")
		}
		return 0, nil
	}, activity.RegisterOptions{Name: RecoverActivityName})
	env.ExecuteWorkflow(MissingPostWorkflow)
	err := env.GetWorkflowError()
	var continueErr *workflow.ContinueAsNewError
	if !errors.As(err, &continueErr) {
		t.Fatalf("expected ContinueAsNewError after 24 iterations, got %v", err)
	}
	// 3 attempts for the failing first iteration + 23 succeeding iterations = 26 calls.
	if calls != 26 {
		t.Fatalf("recovery calls = %d, want 26", calls)
	}
}
