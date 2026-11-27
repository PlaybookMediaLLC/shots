package maintenance

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestSchedulerRunsJobsAndStopsGracefully(t *testing.T) {
	var runs atomic.Int32
	done := make(chan struct{})
	s := &Scheduler{
		Jobs: []PollJob{{Name: "tenant-outbox", Interval: 5 * time.Millisecond}},
		Runner: func(_ context.Context, job string) (int, error) {
			if job != "tenant-outbox" {
				t.Errorf("unexpected job %q", job)
			}
			if runs.Add(1) == 3 {
				close(done)
			}
			return 0, nil
		},
		paused:       func() bool { return false },
		initialDelay: func(PollJob) time.Duration { return 0 },
	}
	stop := s.Start(context.Background())
	defer stop()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatalf("scheduler ran only %d times", runs.Load())
	}
	stop()
	// Calling stop a second time must be a safe no-op.
	stop()
	after := runs.Load()
	time.Sleep(25 * time.Millisecond)
	if got := runs.Load(); got != after {
		t.Fatalf("scheduler continued running after stop: %d -> %d", after, got)
	}
}

func TestSchedulerStopCancelsInFlightAndWaits(t *testing.T) {
	started := make(chan struct{})
	var finished atomic.Bool
	s := &Scheduler{
		Jobs: []PollJob{{Name: "slow", Interval: time.Hour}},
		Runner: func(ctx context.Context, _ string) (int, error) {
			close(started)
			<-ctx.Done()
			time.Sleep(15 * time.Millisecond)
			finished.Store(true)
			return 0, ctx.Err()
		},
		paused:       func() bool { return false },
		initialDelay: func(PollJob) time.Duration { return 0 },
	}
	stop := s.Start(context.Background())
	defer stop()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("job did not start")
	}
	stop()
	if !finished.Load() {
		t.Fatal("stop returned before in-flight job completed cleanup")
	}
}

func TestSchedulerRespectsPaused(t *testing.T) {
	var paused atomic.Bool
	paused.Store(true)
	var runs atomic.Int32
	resumed := make(chan struct{})
	s := &Scheduler{
		Jobs: []PollJob{{Name: "webhooks", Interval: 5 * time.Millisecond}},
		Runner: func(_ context.Context, _ string) (int, error) {
			if runs.Add(1) == 1 {
				close(resumed)
			}
			return 0, nil
		},
		paused:       paused.Load,
		initialDelay: func(PollJob) time.Duration { return 0 },
	}
	stop := s.Start(context.Background())
	defer stop()

	time.Sleep(30 * time.Millisecond)
	if got := runs.Load(); got != 0 {
		t.Fatalf("ran %d times while paused", got)
	}
	paused.Store(false)
	select {
	case <-resumed:
	case <-time.After(2 * time.Second):
		t.Fatal("scheduler did not resume after unpausing")
	}
}

func TestSchedulerAdaptiveBackoff(t *testing.T) {
	timestamps := make(chan time.Time, 8)
	var call atomic.Int32
	s := &Scheduler{
		Jobs: []PollJob{{
			Name:           "webhooks",
			Interval:       300 * time.Millisecond,
			ActiveInterval: 20 * time.Millisecond,
		}},
		Runner: func(_ context.Context, _ string) (int, error) {
			n := call.Add(1)
			if n <= 4 {
				timestamps <- time.Now()
			}
			switch n {
			case 1:
				return 5, nil // work done -> next wait should be ActiveInterval (~20ms)
			case 2:
				return 5, errors.New("partial failure") // error must fall back to Interval (~300ms)
			default:
				return 0, nil // idle -> next wait should be Interval (~300ms)
			}
		},
		paused:       func() bool { return false },
		initialDelay: func(PollJob) time.Duration { return 0 },
	}
	stop := s.Start(context.Background())
	defer stop()

	readTime := func() time.Time {
		t.Helper()
		select {
		case ts := <-timestamps:
			return ts
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for scheduled tick")
			return time.Time{}
		}
	}

	t1 := readTime()
	t2 := readTime()
	t3 := readTime()
	t4 := readTime()
	activeGap := t2.Sub(t1)
	errorGap := t3.Sub(t2)
	idleGap := t4.Sub(t3)
	if activeGap >= 180*time.Millisecond {
		t.Fatalf("active gap = %v, expected near ActiveInterval (20ms)", activeGap)
	}
	if errorGap < 220*time.Millisecond {
		t.Fatalf("error gap = %v, expected fallback to Interval (300ms)", errorGap)
	}
	if idleGap < 220*time.Millisecond {
		t.Fatalf("idle gap = %v, expected near Interval (300ms)", idleGap)
	}
}

func TestSchedulerBoundsConcurrency(t *testing.T) {
	var inFlight, maxSeen atomic.Int32
	entered := make(chan struct{}, 6)
	release := make(chan struct{})
	jobs := make([]PollJob, 6)
	for i := range jobs {
		jobs[i] = PollJob{Name: "job-" + string(rune('a'+i)), Interval: time.Hour}
	}
	s := &Scheduler{
		Jobs:          jobs,
		MaxConcurrent: 2,
		Runner: func(ctx context.Context, _ string) (int, error) {
			cur := inFlight.Add(1)
			for {
				prev := maxSeen.Load()
				if cur <= prev || maxSeen.CompareAndSwap(prev, cur) {
					break
				}
			}
			entered <- struct{}{}
			select {
			case <-release:
			case <-ctx.Done():
			}
			inFlight.Add(-1)
			return 0, nil
		},
		paused:       func() bool { return false },
		initialDelay: func(PollJob) time.Duration { return 0 },
	}
	stop := s.Start(context.Background())
	defer stop()

	// Wait until exactly 2 jobs are simultaneously active in Runner.
	for range 2 {
		select {
		case <-entered:
		case <-time.After(2 * time.Second):
			t.Fatal("expected 2 jobs to enter concurrently")
		}
	}
	// Give the remaining 4 goroutines a moment to prove they stay blocked on the semaphore.
	time.Sleep(25 * time.Millisecond)
	if got := inFlight.Load(); got != 2 {
		t.Fatalf("in-flight = %d while barrier held, want 2", got)
	}
	close(release)
	for range 4 {
		select {
		case <-entered:
		case <-time.After(2 * time.Second):
			t.Fatal("remaining jobs did not run after barrier release")
		}
	}
	stop()
	if got := maxSeen.Load(); got != 2 {
		t.Fatalf("max concurrent = %d, want exactly 2", got)
	}
}

func TestSchedulerRecoversFromPanicAndErrors(t *testing.T) {
	var calls atomic.Int32
	recovered := make(chan struct{})
	s := &Scheduler{
		Jobs:          []PollJob{{Name: "flaky", Interval: 5 * time.Millisecond}},
		MaxConcurrent: 1,
		Runner: func(_ context.Context, _ string) (int, error) {
			switch calls.Add(1) {
			case 1:
				panic("boom")
			case 2:
				return 0, errors.New("temporary failure")
			case 3:
				close(recovered)
				return 1, nil
			default:
				return 0, nil
			}
		},
		paused:       func() bool { return false },
		initialDelay: func(PollJob) time.Duration { return 0 },
	}
	stop := s.Start(context.Background())
	defer stop()

	select {
	case <-recovered:
	case <-time.After(2 * time.Second):
		t.Fatalf("scheduler did not continue after panic/error (calls=%d)", calls.Load())
	}
}

func TestPausedReadsEnv(t *testing.T) {
	t.Setenv("MAINTENANCE_PAUSED", "")
	if Paused() {
		t.Fatal("expected unpaused by default")
	}
	t.Setenv("MAINTENANCE_PAUSED", "true")
	if !Paused() {
		t.Fatal("expected paused when MAINTENANCE_PAUSED=true")
	}
}

type fakeAnalytics struct {
	dueCount    int
	dueErr      error
	socialCount int
	socialErr   error
	socialCalls int
}

func (f *fakeAnalytics) CollectDueAnalytics(context.Context) (int, error) {
	return f.dueCount, f.dueErr
}
func (f *fakeAnalytics) CollectSocialAnalytics(context.Context) (int, error) {
	f.socialCalls++
	return f.socialCount, f.socialErr
}

func TestRunSocialAnalyticsDispatchesBothAndStopsOnError(t *testing.T) {
	a := &fakeAnalytics{dueCount: 3, socialCount: 4}
	s := &Store{Analytics: a}
	n, err := s.runSocialAnalytics(context.Background())
	if err != nil || n != 7 || a.socialCalls != 1 {
		t.Fatalf("got n=%d calls=%d err=%v, want 7, 1, nil", n, a.socialCalls, err)
	}

	boom := errors.New("due analytics failed")
	b := &fakeAnalytics{dueCount: 2, dueErr: boom, socialCount: 5}
	s.Analytics = b
	n, err = s.runSocialAnalytics(context.Background())
	if !errors.Is(err, boom) || n != 2 || b.socialCalls != 0 {
		t.Fatalf("got n=%d calls=%d err=%v, want 2, 0, boom", n, b.socialCalls, err)
	}
}
