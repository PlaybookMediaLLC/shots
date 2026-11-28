// Package temporalmaintenance owns the platform maintenance Temporal worker and
// schedules. Activities execute Go handlers; no web or Trigger.dev runtime is
// involved.
package temporalmaintenance

import (
	"context"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strconv"
	"strings"
	"time"

	commonpb "go.temporal.io/api/common/v1"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

const (
	WorkflowName = "platform-maintenance-v1"
	ActivityName = "platform-maintenance-run-v1"
	TaskQueue    = "platform-maintenance"

	defaultHeartbeatInterval = 30 * time.Second
)

// Jobs lists every maintenance job name accepted by Workflow for scheduled or
// on-demand execution.
var Jobs = []string{
	"frontend-deployments", "tenant-outbox", "audit-drains", "communications",
	"workspace-cleanup", "audit-retention", "scheduled-posts", "notifications",
	"notifications-maintain", "account-deletions", "automation-reminders", "webhooks", "social-analytics",
	"social-token-refresh", "asset-cleanup", "outbox-retention", "voice-cleanup",
	"voice-commands", "notification-retention",
}

// ScheduledJobs are the hourly and daily destructive, cleanup, and retention
// jobs managed as Temporal Schedules. High-frequency DB pollers run in
// maintenance.Scheduler inside product-worker so idle polling incurs no
// Temporal Cloud Schedule actions.
var ScheduledJobs = []string{
	"workspace-cleanup", "account-deletions", "automation-reminders", "asset-cleanup", "voice-cleanup",
	"audit-retention", "outbox-retention", "notification-retention",
}

// RetiredScheduleJobs are legacy Temporal Schedules replaced by
// maintenance.Scheduler. Reconcile deletes any that still exist so they do not
// keep firing in Temporal Cloud.
var RetiredScheduleJobs = []string{
	"frontend-deployments", "tenant-outbox", "audit-drains", "communications",
	"scheduled-posts", "notifications", "webhooks", "social-analytics",
	"social-token-refresh", "voice-commands",
}

type Runner interface {
	Run(context.Context, string) (int, error)
}
type RunnerFunc func(context.Context, string) (int, error)

func (f RunnerFunc) Run(ctx context.Context, job string) (int, error) { return f(ctx, job) }

type Activities struct {
	Runner Runner
	// Test hooks (unexported; zero uses production defaults).
	heartbeatInterval time.Duration
	recordHeartbeat   func(context.Context)
}

func (a *Activities) Run(ctx context.Context, job string) (int, error) {
	if os.Getenv("MAINTENANCE_PAUSED") == "true" {
		return 0, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 9*time.Minute)
	defer cancel()
	interval := a.heartbeatInterval
	if interval <= 0 {
		interval = defaultHeartbeatInterval
	}
	heartbeat := a.recordHeartbeat
	if heartbeat == nil {
		heartbeat = func(ctx context.Context) { activity.RecordHeartbeat(ctx) }
	}
	done := make(chan struct{})
	exited := make(chan struct{})
	go func() {
		defer close(exited)
		// time.NewTicker waits interval before its first tick, so fast runs emit zero heartbeats.
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				heartbeat(ctx)
			}
		}
	}()
	defer func() {
		close(done)
		<-exited
	}()
	n, err := a.Runner.Run(ctx, job)
	if err != nil {
		// SQL/provider errors can contain data or credentials. Keep history/logs safe.
		activity.GetLogger(ctx).Error("maintenance job failed", "job", job)
		return n, fmt.Errorf("maintenance job %s failed", job)
	}
	return n, nil
}

func Workflow(ctx workflow.Context, job string) (int, error) {
	valid := false
	for _, j := range Jobs {
		if j == job {
			valid = true
			break
		}
	}
	if !valid {
		return 0, temporal.NewNonRetryableApplicationError("unknown maintenance job", "InvalidJob", nil)
	}
	ctx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout:    10 * time.Minute,
		ScheduleToCloseTimeout: 35 * time.Minute,
		HeartbeatTimeout:       2 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval: 10 * time.Second,
			MaximumInterval: time.Minute,
			MaximumAttempts: 3,
		},
	})
	var count int
	err := workflow.ExecuteActivity(ctx, ActivityName, job).Get(ctx, &count)
	return count, err
}

func Register(w worker.Worker, runner Runner) {
	w.RegisterWorkflowWithOptions(Workflow, workflow.RegisterOptions{Name: WorkflowName})
	w.RegisterActivityWithOptions((&Activities{Runner: runner}).Run, activity.RegisterOptions{Name: ActivityName})
}

func ScheduleOptions(job string) client.ScheduleOptions {
	spec := client.ScheduleSpec{Intervals: []client.ScheduleIntervalSpec{{Every: time.Hour}}}
	catchup := 5 * time.Minute
	switch job {
	case "workspace-cleanup":
		// Workspace deletions have a 14-day grace period; hourly matches account deletions.
		spec = client.ScheduleSpec{Intervals: []client.ScheduleIntervalSpec{{Every: time.Hour, Offset: 0}}}
		catchup = 24 * time.Hour
	case "account-deletions":
		spec = client.ScheduleSpec{Intervals: []client.ScheduleIntervalSpec{{Every: time.Hour, Offset: 15 * time.Minute}}}
		catchup = 24 * time.Hour
	case "asset-cleanup":
		// Abandoned uploads age in hours, so hourly keeps reserved storage honest.
		spec = client.ScheduleSpec{Intervals: []client.ScheduleIntervalSpec{{Every: time.Hour, Offset: 30 * time.Minute}}}
	case "voice-cleanup":
		spec = client.ScheduleSpec{Intervals: []client.ScheduleIntervalSpec{{Every: time.Hour, Offset: 45 * time.Minute}}}
	case "audit-retention":
		spec = client.ScheduleSpec{CronExpressions: []string{"5 3 * * *"}, TimeZoneName: "UTC"}
		catchup = 24 * time.Hour
	case "outbox-retention":
		spec = client.ScheduleSpec{CronExpressions: []string{"35 3 * * *"}, TimeZoneName: "UTC"}
		catchup = 24 * time.Hour
	case "notification-retention":
		spec = client.ScheduleSpec{CronExpressions: []string{"5 4 * * *"}, TimeZoneName: "UTC"}
		catchup = 24 * time.Hour
	case "automation-reminders":
		spec = client.ScheduleSpec{CronExpressions: []string{"0 14 * * *"}, TimeZoneName: "UTC"}
		catchup = 24 * time.Hour
	}
	return client.ScheduleOptions{
		ID:            "platform-maintenance-" + job,
		Spec:          spec,
		Action:        &client.ScheduleWorkflowAction{ID: "platform-maintenance-" + job, Workflow: WorkflowName, TaskQueue: TaskQueue, Args: []any{job}, WorkflowExecutionTimeout: 40 * time.Minute},
		Overlap:       enumspb.SCHEDULE_OVERLAP_POLICY_SKIP,
		CatchupWindow: catchup,
	}
}

// Reconcile is replica-safe, preserves operator pause state on redeploy, skips
// unchanged schedules, and deletes retired schedules that still exist so none
// remain firing. It updates first and creates only a missing schedule: the
// tracing interceptor records each refused Create or NotFound Delete as an
// error span, so retired schedules are discovered via List before deleting.
func Reconcile(ctx context.Context, schedules client.ScheduleClient) error {
	for _, job := range ScheduledJobs {
		options := ScheduleOptions(job)
		policy := client.SchedulePolicies{Overlap: options.Overlap, CatchupWindow: options.CatchupWindow}
		update := func() error {
			return schedules.GetHandle(ctx, options.ID).Update(ctx, client.ScheduleUpdateOptions{DoUpdate: func(input client.ScheduleUpdateInput) (*client.ScheduleUpdate, error) {
				current := input.Description.Schedule
				if scheduleMatches(current, options, policy) {
					return nil, temporal.ErrSkipScheduleUpdate
				}
				current.Spec = &options.Spec
				current.Action = options.Action
				current.Policy = &policy
				return &client.ScheduleUpdate{Schedule: &current}, nil
			}})
		}
		err := update()
		var missing *serviceerror.NotFound
		if errors.As(err, &missing) {
			_, err = schedules.Create(ctx, options)
			if errors.Is(err, temporal.ErrScheduleAlreadyRunning) {
				// Another replica created it first.
				err = update()
			}
		}
		if err != nil {
			return fmt.Errorf("reconcile %s: %w", options.ID, err)
		}
	}

	retired := make(map[string]struct{}, len(RetiredScheduleJobs))
	for _, job := range RetiredScheduleJobs {
		retired["platform-maintenance-"+job] = struct{}{}
	}
	iter, err := schedules.List(ctx, client.ScheduleListOptions{})
	if err != nil {
		return fmt.Errorf("list schedules: %w", err)
	}
	for iter.HasNext() {
		entry, err := iter.Next()
		if err != nil {
			return fmt.Errorf("list schedules: %w", err)
		}
		if _, ok := retired[entry.ID]; !ok {
			continue
		}
		err = schedules.GetHandle(ctx, entry.ID).Delete(ctx)
		var missing *serviceerror.NotFound
		if err != nil && !errors.As(err, &missing) {
			return fmt.Errorf("delete retired schedule %s: %w", entry.ID, err)
		}
	}
	return nil
}

func scheduleMatches(current client.Schedule, want client.ScheduleOptions, wantPolicy client.SchedulePolicies) bool {
	if current.Policy == nil || *current.Policy != wantPolicy {
		return false
	}
	if !specMatches(current.Spec, want.Spec) {
		return false
	}
	gotAction, ok := current.Action.(*client.ScheduleWorkflowAction)
	wantAction, wantOK := want.Action.(*client.ScheduleWorkflowAction)
	if !ok || !wantOK || gotAction == nil || wantAction == nil {
		return false
	}
	if gotAction.ID != wantAction.ID ||
		gotAction.Workflow != wantAction.Workflow ||
		gotAction.TaskQueue != wantAction.TaskQueue ||
		gotAction.WorkflowExecutionTimeout != wantAction.WorkflowExecutionTimeout ||
		len(gotAction.Args) != len(wantAction.Args) {
		return false
	}
	for i := range wantAction.Args {
		if !sameJobArg(gotAction.Args[i], wantAction.Args[i]) {
			return false
		}
	}
	return true
}

func specMatches(got *client.ScheduleSpec, want client.ScheduleSpec) bool {
	if got == nil || got.TimeZoneName != want.TimeZoneName ||
		got.Jitter != want.Jitter || !got.StartAt.Equal(want.StartAt) || !got.EndAt.Equal(want.EndAt) ||
		len(got.Skip) != len(want.Skip) {
		return false
	}
	if len(want.Intervals) > 0 {
		return len(got.Calendars) == 0 && len(got.CronExpressions) == 0 && reflect.DeepEqual(got.Intervals, want.Intervals)
	}
	if len(want.CronExpressions) == 1 {
		if len(got.Intervals) != 0 {
			return false
		}
		if len(got.Calendars) == 0 && reflect.DeepEqual(got.CronExpressions, want.CronExpressions) {
			return true
		}
		// Temporal server normalizes CronExpressions into structured Calendars on Describe.
		return len(got.CronExpressions) == 0 && matchesDailyCronCalendar(got.Calendars, want.CronExpressions[0])
	}
	return reflect.DeepEqual(*got, want)
}

func matchesDailyCronCalendar(calendars []client.ScheduleCalendarSpec, expr string) bool {
	if len(calendars) != 1 {
		return false
	}
	fields := strings.Fields(expr)
	if len(fields) != 5 || fields[2] != "*" || fields[3] != "*" || fields[4] != "*" {
		return false
	}
	minute, errM := strconv.Atoi(fields[0])
	hour, errH := strconv.Atoi(fields[1])
	if errM != nil || errH != nil {
		return false
	}
	c := calendars[0]
	return isRange(c.Second, 0, 0, true) &&
		isRange(c.Minute, minute, minute, false) &&
		isRange(c.Hour, hour, hour, false) &&
		isRange(c.DayOfMonth, 1, 31, true) &&
		isRange(c.Month, 1, 12, true) &&
		isRange(c.DayOfWeek, 0, 6, true) &&
		len(c.Year) == 0
}

func isRange(ranges []client.ScheduleRange, start, end int, allowEmpty bool) bool {
	if len(ranges) == 0 {
		return allowEmpty
	}
	if len(ranges) != 1 {
		return false
	}
	r := ranges[0]
	return r.Start == start && r.End == end && (r.Step == 0 || r.Step == 1)
}

func sameJobArg(got, want any) bool {
	if got == want {
		return true
	}
	payload, ok := got.(*commonpb.Payload)
	wantStr, wantOK := want.(string)
	if !ok || !wantOK {
		return false
	}
	var decoded string
	if err := converter.GetDefaultDataConverter().FromPayload(payload, &decoded); err != nil {
		return false
	}
	return decoded == wantStr
}
