package maintenance

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"os"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
)

var errJobPanicked = errors.New("maintenance job panicked")

const (
	defaultPollTimeout     = 9 * time.Minute
	defaultMaxConcurrent   = 3
	defaultMaxInitialDelay = 2 * time.Minute
)

// PollJob describes one periodic maintenance job run directly in the worker
// process instead of as a Temporal Schedule. Jobs stay replica-safe through
// Store.WithLock's PostgreSQL advisory locks and DB leases.
type PollJob struct {
	Name string
	// Interval is the wait between runs when idle (or always when ActiveInterval == 0).
	Interval time.Duration
	// ActiveInterval, when positive and shorter than Interval, is used after a
	// run that processed work so queues drain quickly without idle DB churn.
	ActiveInterval time.Duration
}

// DefaultPollJobs are the frequent DB-polling maintenance jobs run directly by
// product-worker. Destructive purges and retention sweeps remain Temporal
// Schedules in package temporalmaintenance.
//
// tenant-outbox stays at 1 minute so non-GitHub outbox events (which retry on
// each poll up to 8 attempts before dead-lettering) keep their ~8-minute retry
// window across transient downstream blips.
var DefaultPollJobs = []PollJob{
	{Name: "webhooks", Interval: 15 * time.Second, ActiveInterval: 5 * time.Second},
	{Name: "notifications", Interval: 15 * time.Second},
	{Name: "scheduled-posts", Interval: 30 * time.Second},
	{Name: "tenant-outbox", Interval: 1 * time.Minute},
	{Name: "audit-drains", Interval: 1 * time.Minute, ActiveInterval: 15 * time.Second},
	{Name: "communications", Interval: 1 * time.Minute},
	{Name: "frontend-deployments", Interval: 1 * time.Minute},
	{Name: "voice-commands", Interval: 2 * time.Minute},
	{Name: "social-token-refresh", Interval: 5 * time.Minute},
	{Name: "social-analytics", Interval: 15 * time.Minute},
	{Name: "notifications-maintain", Interval: 1 * time.Hour},
}

// Paused reports whether MAINTENANCE_PAUSED=true is set. Read on every tick so
// operators can hold maintenance during a database restore without touching
// code, matching PUBLISHING_PAUSED.
func Paused() bool {
	return os.Getenv("MAINTENANCE_PAUSED") == "true"
}

// Scheduler runs PollJobs in bounded concurrent goroutines inside product-worker.
type Scheduler struct {
	Runner        func(ctx context.Context, job string) (int, error)
	Jobs          []PollJob
	MaxConcurrent int

	// Test hooks (unexported; nil uses production defaults).
	paused       func() bool
	initialDelay func(PollJob) time.Duration
}

// Start launches all configured polling loops and returns a stop function that
// cancels them and waits for in-flight runs to finish.
func (s *Scheduler) Start(ctx context.Context) func() {
	runCtx, cancel := context.WithCancel(ctx)
	limit := s.MaxConcurrent
	if limit <= 0 {
		limit = defaultMaxConcurrent
	}
	sem := make(chan struct{}, limit)
	paused := s.paused
	if paused == nil {
		paused = Paused
	}
	initialDelay := s.initialDelay
	if initialDelay == nil {
		initialDelay = func(job PollJob) time.Duration {
			capDelay := min(job.Interval/2, defaultMaxInitialDelay)
			if capDelay <= 0 {
				return 0
			}
			return time.Duration(rand.Int64N(int64(capDelay)))
		}
	}

	var wg sync.WaitGroup
	for _, job := range s.Jobs {
		if job.Name == "" || job.Interval <= 0 || s.Runner == nil {
			continue
		}
		wg.Add(1)
		go func(job PollJob) {
			defer wg.Done()
			s.loop(runCtx, job, sem, paused, initialDelay(job))
		}(job)
	}

	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			wg.Wait()
		})
	}
}

func (s *Scheduler) loop(ctx context.Context, job PollJob, sem chan struct{}, paused func() bool, firstDelay time.Duration) {
	timer := time.NewTimer(firstDelay)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}

		next := job.Interval
		if !paused() {
			count, err := s.runOnce(ctx, job, sem)
			if err == nil && count > 0 && job.ActiveInterval > 0 && job.ActiveInterval < job.Interval {
				next = job.ActiveInterval
			}
		}

		if ctx.Err() != nil {
			return
		}
		timer.Reset(next)
	}
}

func (s *Scheduler) runOnce(ctx context.Context, job PollJob, sem chan struct{}) (count int, err error) {
	if ctx.Err() != nil {
		return 0, ctx.Err()
	}
	select {
	case sem <- struct{}{}:
	case <-ctx.Done():
		return 0, ctx.Err()
	}
	defer func() { <-sem }()
	if ctx.Err() != nil {
		return 0, ctx.Err()
	}

	jobCtx, cancel := context.WithTimeout(ctx, defaultPollTimeout)
	defer cancel()

	jobCtx, span := otel.Tracer("screenshot-studio/maintenance").Start(jobCtx, "maintenance."+job.Name)
	span.SetAttributes(attribute.String("maintenance.job", job.Name))
	defer span.End()

	defer func() {
		if r := recover(); r != nil {
			span.SetStatus(codes.Error, "maintenance job panicked")
			slog.ErrorContext(jobCtx, "maintenance job panicked", "job", job.Name)
			err = errJobPanicked
		}
	}()

	count, err = s.Runner(jobCtx, job.Name)
	span.SetAttributes(attribute.Int("maintenance.count", count))
	if err != nil {
		if ctx.Err() != nil {
			return count, err
		}
		// SQL/provider errors can contain data or credentials. Keep logs and traces safe.
		span.SetStatus(codes.Error, "maintenance job failed")
		slog.ErrorContext(jobCtx, "maintenance job failed", "job", job.Name)
		return count, err
	}
	if count > 0 {
		slog.InfoContext(jobCtx, "maintenance job completed", "job", job.Name, "count", count)
	}
	return count, nil
}
