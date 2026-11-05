package temporalcapture

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/stretchr/testify/mock"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
)

func jobEnvironment(t *testing.T, run func(context.Context, Input) (*product.CaptureJobOutcome, error)) *testsuite.TestWorkflowEnvironment {
	t.Helper()
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterActivityWithOptions(run, activity.RegisterOptions{Name: RunActivity})
	return env
}

func TestJobWorkflowSleepsBetweenAttemptsUntilDone(t *testing.T) {
	calls := 0
	env := jobEnvironment(t, func(context.Context, Input) (*product.CaptureJobOutcome, error) {
		calls++
		if calls < 3 {
			return &product.CaptureJobOutcome{RetryAfterSeconds: 60}, nil
		}
		return &product.CaptureJobOutcome{Done: true}, nil
	})
	started := env.Now()
	env.ExecuteWorkflow(JobWorkflow, Input{OrganizationID: "org", ID: "job"})
	if !env.IsWorkflowCompleted() || env.GetWorkflowError() != nil || calls != 3 {
		t.Fatalf("completed=%v err=%v calls=%d", env.IsWorkflowCompleted(), env.GetWorkflowError(), calls)
	}
	if waited := env.Now().Sub(started); waited < 2*time.Minute {
		t.Fatalf("waited only %s between attempts", waited)
	}
}

func TestJobWorkflowStopsOnADoneJobAndEndsOnExhaustion(t *testing.T) {
	calls := 0
	env := jobEnvironment(t, func(context.Context, Input) (*product.CaptureJobOutcome, error) {
		calls++
		return &product.CaptureJobOutcome{RetryAfterSeconds: 1}, nil
	})
	env.ExecuteWorkflow(JobWorkflow, Input{OrganizationID: "org", ID: "job"})
	if env.GetWorkflowError() == nil || calls != maxJobRounds {
		t.Fatalf("err=%v calls=%d", env.GetWorkflowError(), calls)
	}
}

func TestConnectionWorkflowRunsOnce(t *testing.T) {
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()
	calls := 0
	env.RegisterActivityWithOptions(func(context.Context, Input) error {
		calls++
		return errors.New("provider unavailable")
	}, activity.RegisterOptions{Name: CompleteActivity})
	env.ExecuteWorkflow(ConnectionWorkflow, Input{OrganizationID: "org", ID: "connection"})
	if env.GetWorkflowError() == nil || calls != 1 {
		t.Fatalf("err=%v calls=%d", env.GetWorkflowError(), calls)
	}
}

// Workflow history records inputs and outputs: they carry only IDs and delays.
func TestWorkflowPayloadsCarryNoSessionMaterial(t *testing.T) {
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterActivityWithOptions(func(context.Context, Input) (*product.CaptureJobOutcome, error) {
		return &product.CaptureJobOutcome{Done: true}, nil
	}, activity.RegisterOptions{Name: RunActivity})
	seen := []string{}
	env.OnActivity(RunActivity, mock.Anything, mock.Anything).Return(func(_ context.Context, input Input) (*product.CaptureJobOutcome, error) {
		body, _ := json.Marshal(input)
		seen = append(seen, string(body))
		return &product.CaptureJobOutcome{Done: true}, nil
	})
	env.ExecuteWorkflow(JobWorkflow, Input{OrganizationID: "org", ID: "job"})
	if env.GetWorkflowError() != nil || len(seen) != 1 || strings.Contains(seen[0], "state") || strings.Contains(seen[0], "url") {
		t.Fatalf("err=%v seen=%v", env.GetWorkflowError(), seen)
	}
	for _, payload := range []any{Input{}, product.CaptureJobOutcome{}} {
		body, _ := json.Marshal(payload)
		for _, forbidden := range []string{"cookie", "token", "state", "url", "liveView"} {
			if strings.Contains(strings.ToLower(string(body)), strings.ToLower(forbidden)) {
				t.Errorf("%s carries %s", body, forbidden)
			}
		}
	}
	if safeError(errors.New("https://user:secret@provider/session")).Error() == "" || strings.Contains(safeError(errors.New("secret-url")).Error(), "secret-url") {
		t.Fatal("an activity error carried provider text")
	}
}
