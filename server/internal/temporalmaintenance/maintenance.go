// Package temporalmaintenance owns the platform maintenance schedules.
// Activities execute Go handlers; no web or Trigger.dev runtime is involved.
package temporalmaintenance

import (
	"context"
	"errors"
	"fmt"
	"time"

	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

const WorkflowName = "platform-maintenance-v1"
const ActivityName = "platform-maintenance-run-v1"
const TaskQueue = "platform-maintenance"

var Jobs = []string{"frontend-deployments", "tenant-outbox", "audit-drains", "communications", "workspace-cleanup", "audit-retention", "scheduled-posts", "notifications", "account-deletions", "webhooks", "social-analytics", "social-token-refresh", "asset-cleanup"}

type Runner interface {
	Run(context.Context, string) (int, error)
}
type RunnerFunc func(context.Context, string) (int, error)

func (f RunnerFunc) Run(ctx context.Context, job string) (int, error) { return f(ctx, job) }

type Activities struct{ Runner Runner }

func (a *Activities) Run(ctx context.Context, job string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, 9*time.Minute)
	defer cancel()
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				activity.RecordHeartbeat(ctx)
			}
		}
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
	ctx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: 10 * time.Minute, ScheduleToCloseTimeout: 35 * time.Minute, HeartbeatTimeout: time.Minute, RetryPolicy: &temporal.RetryPolicy{InitialInterval: 10 * time.Second, MaximumInterval: time.Minute, MaximumAttempts: 3}})
	var count int
	err := workflow.ExecuteActivity(ctx, ActivityName, job).Get(ctx, &count)
	return count, err
}
func Register(w worker.Worker, runner Runner) {
	w.RegisterWorkflowWithOptions(Workflow, workflow.RegisterOptions{Name: WorkflowName})
	w.RegisterActivityWithOptions((&Activities{Runner: runner}).Run, activity.RegisterOptions{Name: ActivityName})
}
func ScheduleOptions(job string) client.ScheduleOptions {
	spec := client.ScheduleSpec{Intervals: []client.ScheduleIntervalSpec{{Every: time.Minute}}}
	catchup := 5 * time.Minute
	if job == "social-analytics" {
		spec = client.ScheduleSpec{Intervals: []client.ScheduleIntervalSpec{{Every: 15 * time.Minute}}}
	}
	if job == "account-deletions" {
		spec = client.ScheduleSpec{Intervals: []client.ScheduleIntervalSpec{{Every: time.Hour}}}
		catchup = 24 * time.Hour
	}
	if job == "asset-cleanup" {
		// Abandoned uploads age in hours, so hourly keeps reserved storage honest.
		spec = client.ScheduleSpec{Intervals: []client.ScheduleIntervalSpec{{Every: time.Hour}}}
	}
	if job == "social-token-refresh" {
		// Tokens renew a week before expiry; hourly retries a failed renewal often enough.
		spec = client.ScheduleSpec{Intervals: []client.ScheduleIntervalSpec{{Every: time.Hour}}}
	}
	if job == "audit-retention" {
		spec = client.ScheduleSpec{CronExpressions: []string{"5 3 * * *"}, TimeZoneName: "UTC"}
		catchup = 24 * time.Hour
	}
	return client.ScheduleOptions{ID: "platform-maintenance-" + job, Spec: spec, Action: &client.ScheduleWorkflowAction{ID: "platform-maintenance-" + job, Workflow: WorkflowName, TaskQueue: TaskQueue, Args: []any{job}, WorkflowExecutionTimeout: 40 * time.Minute}, Overlap: enumspb.SCHEDULE_OVERLAP_POLICY_SKIP, CatchupWindow: catchup}
}

// Reconcile is replica-safe and preserves operator pause state on redeploy.
// It updates first and creates only a missing schedule: the tracing
// interceptor records each refused Create as an error span.
func Reconcile(ctx context.Context, schedules client.ScheduleClient) error {
	for _, job := range Jobs {
		options := ScheduleOptions(job)
		update := func() error {
			return schedules.GetHandle(ctx, options.ID).Update(ctx, client.ScheduleUpdateOptions{DoUpdate: func(input client.ScheduleUpdateInput) (*client.ScheduleUpdate, error) {
				current := input.Description.Schedule
				current.Spec = &options.Spec
				current.Action = options.Action
				current.Policy = &client.SchedulePolicies{Overlap: options.Overlap, CatchupWindow: options.CatchupWindow}
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
	return nil
}
