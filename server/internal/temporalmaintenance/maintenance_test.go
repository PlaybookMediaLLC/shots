package temporalmaintenance

import (
	"context"
	"errors"
	"fmt"
	"os"
	"reflect"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/maintenance"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
)

func TestWorkflowRetriesAndPropagatesExhaustedFailures(t *testing.T) {
	for _, failures := range []int{1, 4} {
		t.Run(fmt.Sprint(failures), func(t *testing.T) {
			var suite testsuite.WorkflowTestSuite
			env := suite.NewTestWorkflowEnvironment()
			calls := 0
			env.RegisterActivityWithOptions(func(_ context.Context, job string) (int, error) {
				calls++
				if job != "tenant-outbox" {
					t.Fatal(job)
				}
				if calls <= failures {
					return 0, fmt.Errorf("temporary")
				}
				return 3, nil
			}, activity.RegisterOptions{Name: ActivityName})
			env.ExecuteWorkflow(Workflow, "tenant-outbox")
			if failures == 1 {
				if env.GetWorkflowError() != nil {
					t.Fatal(env.GetWorkflowError())
				}
				var count int
				if err := env.GetWorkflowResult(&count); err != nil || count != 3 {
					t.Fatalf("count %d error %v", count, err)
				}
				if calls != 2 {
					t.Fatal(calls)
				}
			} else {
				if env.GetWorkflowError() == nil || calls != 3 {
					t.Fatalf("error %v calls %d", env.GetWorkflowError(), calls)
				}
			}
		})
	}
}

func TestUnknownJobIsRejected(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.ExecuteWorkflow(Workflow, "invalid-job")
	if env.GetWorkflowError() == nil {
		t.Fatal("unknown jobs must not execute")
	}
}

func TestJobPartitionBetweenTemporalSchedulesAndInProcessPoller(t *testing.T) {
	seen := map[string]string{}
	for _, job := range ScheduledJobs {
		if !slices.Contains(Jobs, job) {
			t.Fatalf("scheduled job %q is not in Jobs", job)
		}
		if prev, dup := seen[job]; dup {
			t.Fatalf("job %q listed in both %s and ScheduledJobs", job, prev)
		}
		seen[job] = "ScheduledJobs"
	}
	for _, job := range maintenance.DefaultPollJobs {
		if !slices.Contains(Jobs, job.Name) {
			t.Fatalf("polled job %q is not in Jobs", job.Name)
		}
		if prev, dup := seen[job.Name]; dup {
			t.Fatalf("job %q listed in both %s and DefaultPollJobs", job.Name, prev)
		}
		seen[job.Name] = "DefaultPollJobs"
	}
	for _, job := range Jobs {
		if _, ok := seen[job]; !ok {
			t.Fatalf("job %q is neither a Temporal Schedule nor in maintenance.DefaultPollJobs", job)
		}
	}
	retiredSeen := map[string]bool{}
	for _, retired := range RetiredScheduleJobs {
		if !slices.Contains(Jobs, retired) {
			t.Fatalf("retired schedule %q is not a valid job name", retired)
		}
		if retiredSeen[retired] {
			t.Fatalf("retired schedule %q is duplicated", retired)
		}
		retiredSeen[retired] = true
		if slices.Contains(ScheduledJobs, retired) {
			t.Fatalf("retired schedule %q is still in ScheduledJobs", retired)
		}
	}
}

func TestActivitiesRespectMaintenancePaused(t *testing.T) {
	t.Setenv("MAINTENANCE_PAUSED", "true")
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestActivityEnvironment()
	called := false
	acts := &Activities{
		Runner: RunnerFunc(func(context.Context, string) (int, error) {
			called = true
			return 5, nil
		}),
	}
	env.RegisterActivityWithOptions(acts.Run, activity.RegisterOptions{Name: ActivityName})
	val, err := env.ExecuteActivity(ActivityName, "workspace-cleanup")
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := val.Get(&count); err != nil || count != 0 || called {
		t.Fatalf("paused activity ran: count=%d called=%v err=%v", count, called, err)
	}
}

func TestActivitiesDelayHeartbeatForFastRuns(t *testing.T) {
	t.Run("fast run emits zero heartbeats", func(t *testing.T) {
		var suite testsuite.WorkflowTestSuite
		env := suite.NewTestActivityEnvironment()
		var heartbeats atomic.Int32
		env.SetOnActivityHeartbeatListener(func(_ *activity.Info, _ converter.EncodedValues) {
			heartbeats.Add(1)
		})
		acts := &Activities{
			Runner:            RunnerFunc(func(context.Context, string) (int, error) { return 1, nil }),
			heartbeatInterval: 100 * time.Millisecond,
		}
		env.RegisterActivityWithOptions(acts.Run, activity.RegisterOptions{Name: ActivityName})
		val, err := env.ExecuteActivity(ActivityName, "webhooks")
		if err != nil {
			t.Fatal(err)
		}
		var count int
		if err := val.Get(&count); err != nil || count != 1 {
			t.Fatalf("count=%d err=%v", count, err)
		}
		if got := heartbeats.Load(); got != 0 {
			t.Fatalf("fast run recorded %d heartbeats, want 0", got)
		}
	})

	t.Run("slow run heartbeats periodically", func(t *testing.T) {
		var suite testsuite.WorkflowTestSuite
		env := suite.NewTestActivityEnvironment()
		var sdkBeats, calls atomic.Int32
		twoBeats := make(chan struct{})
		env.SetOnActivityHeartbeatListener(func(_ *activity.Info, _ converter.EncodedValues) {
			sdkBeats.Add(1)
		})
		acts := &Activities{
			Runner: RunnerFunc(func(ctx context.Context, _ string) (int, error) {
				select {
				case <-twoBeats:
					return 2, nil
				case <-ctx.Done():
					return 0, ctx.Err()
				}
			}),
			heartbeatInterval: 10 * time.Millisecond,
			recordHeartbeat: func(ctx context.Context) {
				activity.RecordHeartbeat(ctx)
				if calls.Add(1) == 2 {
					close(twoBeats)
				}
			},
		}
		env.RegisterActivityWithOptions(acts.Run, activity.RegisterOptions{Name: ActivityName})
		if _, err := env.ExecuteActivity(ActivityName, "audit-retention"); err != nil {
			t.Fatal(err)
		}
		if got := calls.Load(); got < 2 {
			t.Fatalf("slow run triggered %d heartbeat calls, want >= 2", got)
		}
		if got := sdkBeats.Load(); got == 0 {
			t.Fatal("slow run recorded 0 SDK heartbeats, want >= 1")
		}
	})
}

type fakeListIterator struct {
	ids []string
	idx int
}

func (it *fakeListIterator) HasNext() bool { return it.idx < len(it.ids) }
func (it *fakeListIterator) Next() (*client.ScheduleListEntry, error) {
	id := it.ids[it.idx]
	it.idx++
	return &client.ScheduleListEntry{ID: id}, nil
}

type fakeSchedules struct {
	client.ScheduleClient
	created     map[string]client.ScheduleOptions
	handles     map[string]*fakeHandle
	creates     int
	updates     int
	deleteCalls int
	deleted     []string
	deleteErr   map[string]error
}
type fakeHandle struct {
	client.ScheduleHandle
	id       string
	parent   *fakeSchedules
	schedule client.Schedule
}
type failingHandle struct {
	client.ScheduleHandle
	err error
}

func (f *fakeSchedules) Create(_ context.Context, o client.ScheduleOptions) (client.ScheduleHandle, error) {
	f.creates++
	if _, ok := f.created[o.ID]; ok {
		return nil, temporal.ErrScheduleAlreadyRunning
	}
	f.created[o.ID] = o
	policy := client.SchedulePolicies{Overlap: o.Overlap, CatchupWindow: o.CatchupWindow}
	f.handles[o.ID] = &fakeHandle{
		id:       o.ID,
		parent:   f,
		schedule: client.Schedule{Spec: &o.Spec, Action: o.Action, Policy: &policy, State: &client.ScheduleState{Paused: true}},
	}
	return f.handles[o.ID], nil
}
func (f *fakeSchedules) List(context.Context, client.ScheduleListOptions) (client.ScheduleListIterator, error) {
	ids := make([]string, 0, len(f.handles))
	for id := range f.handles {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return &fakeListIterator{ids: ids}, nil
}
func (f *fakeSchedules) GetHandle(_ context.Context, id string) client.ScheduleHandle {
	if handle, ok := f.handles[id]; ok {
		return handle
	}
	return failingHandle{err: serviceerror.NewNotFound("schedule not found")}
}
func (h failingHandle) Update(context.Context, client.ScheduleUpdateOptions) error {
	return h.err
}
func (f *fakeHandle) Update(_ context.Context, o client.ScheduleUpdateOptions) error {
	u, e := o.DoUpdate(client.ScheduleUpdateInput{Description: client.ScheduleDescription{Schedule: f.schedule}})
	if errors.Is(e, temporal.ErrSkipScheduleUpdate) {
		return nil
	}
	if e == nil {
		f.parent.updates++
		f.schedule = *u.Schedule
	}
	return e
}
func (f *fakeHandle) Delete(context.Context) error {
	f.parent.deleteCalls++
	if err := f.parent.deleteErr[f.id]; err != nil {
		return err
	}
	f.parent.deleted = append(f.parent.deleted, f.id)
	delete(f.parent.handles, f.id)
	delete(f.parent.created, f.id)
	return nil
}

// Another replica, still on the previous release, creates each schedule
// between this replica's update and its create.
type racedSchedules struct{ *fakeSchedules }

func (r racedSchedules) Create(ctx context.Context, o client.ScheduleOptions) (client.ScheduleHandle, error) {
	previous := o
	previous.Spec = client.ScheduleSpec{Intervals: []client.ScheduleIntervalSpec{{Every: 7 * time.Minute}}}
	previous.Action = &client.ScheduleWorkflowAction{ID: o.ID, Workflow: "platform-maintenance-v0", TaskQueue: TaskQueue}
	_, _ = r.fakeSchedules.Create(ctx, previous)
	return r.fakeSchedules.Create(ctx, o)
}

func TestScheduleReconciliationUpdatesWhenAnotherReplicaCreatesFirst(t *testing.T) {
	f := &fakeSchedules{created: map[string]client.ScheduleOptions{}, handles: map[string]*fakeHandle{}}
	if err := Reconcile(context.Background(), racedSchedules{f}); err != nil {
		t.Fatal(err)
	}
	for _, job := range ScheduledJobs {
		want := ScheduleOptions(job)
		got := f.handles[want.ID].schedule
		policy := client.SchedulePolicies{Overlap: want.Overlap, CatchupWindow: want.CatchupWindow}
		if !reflect.DeepEqual(*got.Spec, want.Spec) || !reflect.DeepEqual(got.Action, want.Action) || got.Policy == nil || *got.Policy != policy {
			t.Fatalf("%s kept the other replica's schedule", want.ID)
		}
	}
}

// Temporal cannot answer: Reconcile reports that error and creates nothing.
type unavailableSchedules struct{ *fakeSchedules }

func (unavailableSchedules) GetHandle(context.Context, string) client.ScheduleHandle {
	return failingHandle{err: serviceerror.NewUnavailable("temporal unavailable")}
}

func TestScheduleReconciliationCreatesOnlyMissingSchedules(t *testing.T) {
	f := &fakeSchedules{created: map[string]client.ScheduleOptions{}, handles: map[string]*fakeHandle{}}
	err := Reconcile(context.Background(), unavailableSchedules{f})
	var unavailable *serviceerror.Unavailable
	if !errors.As(err, &unavailable) || f.creates != 0 {
		t.Fatalf("got %v after %d creates", err, f.creates)
	}
}

func TestScheduleReconciliationPreservesPauseSkipsNoOpsAndDeletesRetired(t *testing.T) {
	f := &fakeSchedules{created: map[string]client.ScheduleOptions{}, handles: map[string]*fakeHandle{}}
	// Pre-seed legacy retired schedules as if upgrading from the 17-schedule release.
	for _, job := range RetiredScheduleJobs {
		if _, err := f.Create(context.Background(), ScheduleOptions(job)); err != nil {
			t.Fatal(err)
		}
	}
	// Pre-seed drifted workspace-cleanup at its old 1m cadence to prove migration updates only it.
	legacyWC := ScheduleOptions("workspace-cleanup")
	legacyWC.Spec = client.ScheduleSpec{Intervals: []client.ScheduleIntervalSpec{{Every: time.Minute}}}
	legacyWC.CatchupWindow = 5 * time.Minute
	if _, err := f.Create(context.Background(), legacyWC); err != nil {
		t.Fatal(err)
	}
	f.creates = 0

	if err := Reconcile(context.Background(), f); err != nil {
		t.Fatal(err)
	}
	if f.updates != 1 {
		t.Fatalf("expected exactly 1 update (migrated workspace-cleanup), got %d", f.updates)
	}
	if len(f.deleted) != len(RetiredScheduleJobs) || f.deleteCalls != len(RetiredScheduleJobs) {
		t.Fatalf("deleted %d (calls=%d), want %d", len(f.deleted), f.deleteCalls, len(RetiredScheduleJobs))
	}

	// Second Reconcile must issue 0 Creates, 0 Updates, and 0 Deletes.
	if err := Reconcile(context.Background(), f); err != nil {
		t.Fatal(err)
	}
	if len(f.created) != len(ScheduledJobs) {
		t.Fatalf("active schedules = %d, want %d", len(f.created), len(ScheduledJobs))
	}
	if f.creates != len(ScheduledJobs)-1 {
		t.Fatalf("called Create %d times, want %d", f.creates, len(ScheduledJobs)-1)
	}
	if f.updates != 1 {
		t.Fatalf("second Reconcile issued spurious updates: total=%d", f.updates)
	}
	if f.deleteCalls != len(RetiredScheduleJobs) {
		t.Fatalf("second Reconcile issued redundant Delete calls: total=%d", f.deleteCalls)
	}
	for _, job := range RetiredScheduleJobs {
		if _, exists := f.handles["platform-maintenance-"+job]; exists {
			t.Fatalf("retired schedule %s was not deleted", job)
		}
	}
	for id, handle := range f.handles {
		got := handle.schedule
		if got.Policy.Overlap != enumspb.SCHEDULE_OVERLAP_POLICY_SKIP {
			t.Fatal("overlap enabled")
		}
		if !got.State.Paused {
			t.Fatal("operator pause cleared")
		}
		switch id {
		case "platform-maintenance-audit-retention":
			if got.Spec.TimeZoneName != "UTC" || got.Spec.CronExpressions[0] != "5 3 * * *" || got.Policy.CatchupWindow != 24*time.Hour {
				t.Fatal(got.Spec)
			}
		case "platform-maintenance-outbox-retention":
			if got.Spec.TimeZoneName != "UTC" || got.Spec.CronExpressions[0] != "35 3 * * *" || got.Policy.CatchupWindow != 24*time.Hour {
				t.Fatal(got.Spec)
			}
		case "platform-maintenance-notification-retention":
			if got.Spec.TimeZoneName != "UTC" || got.Spec.CronExpressions[0] != "5 4 * * *" || got.Policy.CatchupWindow != 24*time.Hour {
				t.Fatal(got.Spec)
			}
		case "platform-maintenance-workspace-cleanup":
			want := client.ScheduleIntervalSpec{Every: time.Hour, Offset: 0}
			if len(got.Spec.Intervals) != 1 || got.Spec.Intervals[0] != want || got.Policy.CatchupWindow != 24*time.Hour {
				t.Fatalf("workspace-cleanup spec=%+v policy=%+v", got.Spec, got.Policy)
			}
		case "platform-maintenance-account-deletions":
			want := client.ScheduleIntervalSpec{Every: time.Hour, Offset: 15 * time.Minute}
			if len(got.Spec.Intervals) != 1 || got.Spec.Intervals[0] != want || got.Policy.CatchupWindow != 24*time.Hour {
				t.Fatalf("account-deletions spec=%+v policy=%+v", got.Spec, got.Policy)
			}
		case "platform-maintenance-asset-cleanup":
			want := client.ScheduleIntervalSpec{Every: time.Hour, Offset: 30 * time.Minute}
			if len(got.Spec.Intervals) != 1 || got.Spec.Intervals[0] != want {
				t.Fatalf("asset-cleanup spec=%+v", got.Spec)
			}
		case "platform-maintenance-automation-reminders":
			if got.Spec.TimeZoneName != "UTC" || len(got.Spec.CronExpressions) != 1 || got.Spec.CronExpressions[0] != "0 14 * * *" || got.Policy.CatchupWindow != 24*time.Hour {
				t.Fatalf("automation-reminders spec=%+v policy=%+v", got.Spec, got.Policy)
			}
		case "platform-maintenance-voice-cleanup":
			want := client.ScheduleIntervalSpec{Every: time.Hour, Offset: 45 * time.Minute}
			if len(got.Spec.Intervals) != 1 || got.Spec.Intervals[0] != want {
				t.Fatalf("voice-cleanup spec=%+v", got.Spec)
			}
		default:
			t.Fatalf("unexpected scheduled job %s", id)
		}
		if got.Action.(*client.ScheduleWorkflowAction).TaskQueue != TaskQueue {
			t.Fatal("maintenance must have a separate queue")
		}
	}
}

func TestScheduleReconciliationPropagatesDeleteFailureAndToleratesNotFound(t *testing.T) {
	t.Run("tolerates NotFound from concurrent replica delete", func(t *testing.T) {
		f := &fakeSchedules{
			created:   map[string]client.ScheduleOptions{},
			handles:   map[string]*fakeHandle{},
			deleteErr: map[string]error{"platform-maintenance-webhooks": serviceerror.NewNotFound("already deleted")},
		}
		if _, err := f.Create(context.Background(), ScheduleOptions("webhooks")); err != nil {
			t.Fatal(err)
		}
		if err := Reconcile(context.Background(), f); err != nil {
			t.Fatalf("expected NotFound delete to be ignored, got %v", err)
		}
	})

	t.Run("propagates non-NotFound delete error", func(t *testing.T) {
		f := &fakeSchedules{
			created:   map[string]client.ScheduleOptions{},
			handles:   map[string]*fakeHandle{},
			deleteErr: map[string]error{"platform-maintenance-webhooks": serviceerror.NewUnavailable("temporal unavailable")},
		}
		if _, err := f.Create(context.Background(), ScheduleOptions("webhooks")); err != nil {
			t.Fatal(err)
		}
		err := Reconcile(context.Background(), f)
		var unavailable *serviceerror.Unavailable
		if !errors.As(err, &unavailable) {
			t.Fatalf("expected Unavailable delete error, got %v", err)
		}
	})
}

func TestScheduleMatchesTemporalNormalizedDescribe(t *testing.T) {
	dc := converter.GetDefaultDataConverter()
	payload, err := dc.ToPayload("audit-retention")
	if err != nil {
		t.Fatal(err)
	}
	want := ScheduleOptions("audit-retention")
	policy := client.SchedulePolicies{Overlap: want.Overlap, CatchupWindow: want.CatchupWindow}
	described := client.Schedule{
		Spec: &client.ScheduleSpec{
			TimeZoneName: "UTC",
			Calendars: []client.ScheduleCalendarSpec{{
				Second:     []client.ScheduleRange{{Start: 0, End: 0, Step: 1}},
				Minute:     []client.ScheduleRange{{Start: 5, End: 5, Step: 1}},
				Hour:       []client.ScheduleRange{{Start: 3, End: 3, Step: 1}},
				DayOfMonth: []client.ScheduleRange{{Start: 1, End: 31, Step: 1}},
				Month:      []client.ScheduleRange{{Start: 1, End: 12, Step: 1}},
				DayOfWeek:  []client.ScheduleRange{{Start: 0, End: 6, Step: 1}},
			}},
		},
		Action: &client.ScheduleWorkflowAction{
			ID:                       "platform-maintenance-audit-retention",
			Workflow:                 WorkflowName,
			TaskQueue:                TaskQueue,
			Args:                     []any{payload},
			WorkflowExecutionTimeout: 40 * time.Minute,
		},
		Policy: &policy,
	}
	if !scheduleMatches(described, want, policy) {
		t.Fatal("expected Temporal-normalized daily schedule to match without spurious update")
	}
	// Changing DayOfWeek must be detected as drift.
	described.Spec.Calendars[0].DayOfWeek = []client.ScheduleRange{{Start: 1, End: 5, Step: 1}}
	if scheduleMatches(described, want, policy) {
		t.Fatal("expected calendar drift to trigger an update")
	}
}

func TestScheduleReconciliationLiveTemporal(t *testing.T) {
	address := os.Getenv("PUBLISHING_TEST_TEMPORAL_ADDRESS")
	if address == "" {
		t.Skip("PUBLISHING_TEST_TEMPORAL_ADDRESS is not set")
	}
	c, err := client.Dial(client.Options{HostPort: address})
	if err != nil {
		t.Fatal(err)
	}
	// Register Close before schedule deletion so LIFO cleanup deletes while c is open.
	t.Cleanup(c.Close)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	schedules := c.ScheduleClient()
	legacy := ScheduleOptions("tenant-outbox")
	legacy.Paused = true
	t.Cleanup(func() {
		cleanCtx, cleanCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanCancel()
		ids := append(make([]string, 0, 1+len(ScheduledJobs)), legacy.ID)
		for _, job := range ScheduledJobs {
			ids = append(ids, "platform-maintenance-"+job)
		}
		for _, id := range ids {
			err := schedules.GetHandle(cleanCtx, id).Delete(cleanCtx)
			var notFound *serviceerror.NotFound
			if err != nil && !errors.As(err, &notFound) {
				t.Errorf("cleanup delete %s: %v", id, err)
			}
		}
	})

	// Seed a legacy retired schedule and wait for Temporal Visibility to index it.
	if _, err := schedules.Create(ctx, legacy); err != nil && !errors.Is(err, temporal.ErrScheduleAlreadyRunning) {
		t.Fatal(err)
	}
	waitDeadline := time.Now().Add(5 * time.Second)
	for {
		iter, err := schedules.List(ctx, client.ScheduleListOptions{})
		if err != nil {
			t.Fatalf("list schedules: %v", err)
		}
		found := false
		for iter.HasNext() {
			entry, err := iter.Next()
			if err != nil {
				t.Fatalf("list next: %v", err)
			}
			if entry.ID == legacy.ID {
				found = true
				break
			}
		}
		if found {
			break
		}
		if time.Now().After(waitDeadline) {
			t.Fatalf("retired schedule %s did not appear in List before timeout", legacy.ID)
		}
		time.Sleep(50 * time.Millisecond)
	}

	if err := Reconcile(ctx, schedules); err != nil {
		t.Fatalf("first Reconcile: %v", err)
	}
	_, err = schedules.GetHandle(ctx, legacy.ID).Describe(ctx)
	var notFound *serviceerror.NotFound
	if !errors.As(err, &notFound) {
		t.Fatalf("retired schedule %s describe err = %v, want NotFound", legacy.ID, err)
	}

	// Capture LastUpdateTime before the second Reconcile to prove zero server updates occur.
	beforeUpdate := make(map[string]time.Time, len(ScheduledJobs))
	for _, job := range ScheduledJobs {
		want := ScheduleOptions(job)
		policy := client.SchedulePolicies{Overlap: want.Overlap, CatchupWindow: want.CatchupWindow}
		desc, err := schedules.GetHandle(ctx, want.ID).Describe(ctx)
		if err != nil {
			t.Fatalf("describe %s: %v", want.ID, err)
		}
		if !scheduleMatches(desc.Schedule, want, policy) {
			t.Fatalf("live Temporal description for %s did not match want (spec=%+v, policy=%+v)", want.ID, desc.Schedule.Spec, desc.Schedule.Policy)
		}
		beforeUpdate[want.ID] = desc.Info.LastUpdateAt
	}
	if err := Reconcile(ctx, schedules); err != nil {
		t.Fatalf("second Reconcile: %v", err)
	}
	for _, job := range ScheduledJobs {
		id := "platform-maintenance-" + job
		desc, err := schedules.GetHandle(ctx, id).Describe(ctx)
		if err != nil {
			t.Fatalf("describe %s after second Reconcile: %v", id, err)
		}
		if !desc.Info.LastUpdateAt.Equal(beforeUpdate[id]) {
			t.Fatalf("schedule %s was unexpectedly updated on repeat Reconcile (%v -> %v)", id, beforeUpdate[id], desc.Info.LastUpdateAt)
		}
	}
}
