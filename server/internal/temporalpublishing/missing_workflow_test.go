package temporalpublishing

import (
	"context"
	"errors"
	"testing"
	"time"

	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/testsuite"
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

func TestDispatchDueAndRecoverRespectPublishingPaused(t *testing.T) {
	t.Setenv("PUBLISHING_PAUSED", "true")
	// Nil store/scheduler would panic if touched; paused must short-circuit first.
	recovery := NewRecoveryActivities(nil, nil)
	if n, err := recovery.DispatchDue(context.Background()); err != nil || n != 0 {
		t.Fatalf("DispatchDue while paused = (%d, %v), want (0, nil)", n, err)
	}
	if n, err := recovery.Recover(context.Background()); err != nil || n != 0 {
		t.Fatalf("Recover while paused = (%d, %v), want (0, nil)", n, err)
	}
}

type fakeCancelClient struct {
	client.Client
	gotID string
	err   error
}

func (f *fakeCancelClient) CancelWorkflow(_ context.Context, workflowID, _ string) error {
	f.gotID = workflowID
	return f.err
}

func TestCancelMissingWorkflowIgnoresNotFoundAndAlreadyRequested(t *testing.T) {
	fc := &fakeCancelClient{err: serviceerror.NewNotFound("not found")}
	s := NewScheduler(fc, SchedulerConfig{})
	if err := s.CancelMissingWorkflow(context.Background()); err != nil {
		t.Fatalf("expected NotFound to be ignored, got %v", err)
	}
	if fc.gotID != MissingWorkflowID {
		t.Fatalf("cancelled %q, want %q", fc.gotID, MissingWorkflowID)
	}

	fc.err = serviceerror.NewCancellationAlreadyRequested("already cancelling")
	if err := s.CancelMissingWorkflow(context.Background()); err != nil {
		t.Fatalf("expected CancellationAlreadyRequested to be ignored, got %v", err)
	}

	boom := errors.New("temporal unavailable")
	fc.err = boom
	if err := s.CancelMissingWorkflow(context.Background()); !errors.Is(err, boom) {
		t.Fatalf("expected error %v, got %v", boom, err)
	}
}
