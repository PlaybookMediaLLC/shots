package temporalbatches

import (
	"context"
	"errors"
	"testing"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/ent"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/product"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/temporalpublishing"
)

type fakeStore struct {
	steps       []func() (*product.BatchRunStep, error)
	calls       int
	unconfirmed int
}

func (f *fakeStore) ScheduleNextBatchRunItem(context.Context, string, string) (*product.BatchRunStep, error) {
	step := f.steps[min(f.calls, len(f.steps)-1)]
	f.calls++
	return step()
}

func (f *fakeStore) MarkBatchRunItemUnconfirmed(context.Context, string, string) error {
	f.unconfirmed++
	// The stuck item is settled, so the next step finds nothing left.
	f.steps = []func() (*product.BatchRunStep, error){func() (*product.BatchRunStep, error) { return &product.BatchRunStep{Done: true}, nil }}
	f.calls = 0
	return nil
}

type fakePublisher struct {
	started   []string
	cancelled []string
	err       error
}

func (f *fakePublisher) Start(_ context.Context, input temporalpublishing.ScheduleInput) error {
	f.started = append(f.started, input.PostID)
	return f.err
}

func (f *fakePublisher) Cancel(_ context.Context, postID string) error {
	f.cancelled = append(f.cancelled, postID)
	return f.err
}

func run(t *testing.T, store Store, publisher Publisher) {
	t.Helper()
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	activities := &Activities{Publisher: publisher, Store: store}
	env.RegisterActivityWithOptions(activities.Next, activity.RegisterOptions{Name: NextActivity})
	env.RegisterActivityWithOptions(activities.Unconfirmed, activity.RegisterOptions{Name: UnconfirmedActivity})
	env.ExecuteWorkflow(Workflow, Input{OrganizationID: "org", RunID: "run"})
	if !env.IsWorkflowCompleted() || env.GetWorkflowError() != nil {
		t.Fatalf("workflow: completed=%v err=%v", env.IsWorkflowCompleted(), env.GetWorkflowError())
	}
}

func TestWorkflowSchedulesEachItemAndWakesItsPosts(t *testing.T) {
	store := &fakeStore{steps: []func() (*product.BatchRunStep, error){
		func() (*product.BatchRunStep, error) {
			return &product.BatchRunStep{Cancelled: []string{"old"}, Scheduled: []*ent.ScheduledPost{{ID: "one"}}}, nil
		},
		func() (*product.BatchRunStep, error) {
			return &product.BatchRunStep{Done: true, Scheduled: []*ent.ScheduledPost{{ID: "two"}}}, nil
		},
	}}
	publisher := &fakePublisher{}
	run(t, store, publisher)
	if store.calls != 2 || len(publisher.started) != 2 || publisher.cancelled[0] != "old" {
		t.Fatalf("calls=%d started=%v cancelled=%v", store.calls, publisher.started, publisher.cancelled)
	}
}

func TestWorkflowKeepsGoingWhenAWakeupFails(t *testing.T) {
	store := &fakeStore{steps: []func() (*product.BatchRunStep, error){
		func() (*product.BatchRunStep, error) {
			return &product.BatchRunStep{Done: true, Scheduled: []*ent.ScheduledPost{{ID: "one"}}}, nil
		},
	}}
	// The post is committed; the dispatcher starts it. The item is not retried.
	run(t, store, &fakePublisher{err: errors.New("temporal down")})
	if store.calls != 1 || store.unconfirmed != 0 {
		t.Fatalf("calls=%d unconfirmed=%d", store.calls, store.unconfirmed)
	}
}

func TestWorkflowMarksAnItemWithNoAnswerAndGoesOn(t *testing.T) {
	store := &fakeStore{steps: []func() (*product.BatchRunStep, error){
		func() (*product.BatchRunStep, error) { return nil, errors.New("database unavailable") },
	}}
	run(t, store, &fakePublisher{})
	// Retried by Temporal, then marked; the next step finishes the run.
	if store.unconfirmed != 1 {
		t.Fatalf("unconfirmed=%d", store.unconfirmed)
	}
}
