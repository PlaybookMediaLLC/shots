package temporalpublishing

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/publishing"
)

const (
	recoveryBatchSize = 100
	recoveryMaxPages  = 5
	recoveryLookback  = 48 * time.Hour
	// stalledAfter is how long a claimed post may make no progress before the
	// sweep asks Temporal whether its workflow still runs.
	stalledAfter = 15 * time.Minute
)

type RecoveryActivities struct {
	scheduler *Scheduler
	store     *publishing.Repository
}

func NewRecoveryActivities(store *publishing.Repository, scheduler *Scheduler) *RecoveryActivities {
	return &RecoveryActivities{scheduler: scheduler, store: store}
}

func (a *RecoveryActivities) Recover(ctx context.Context) (int, error) {
	if os.Getenv("PUBLISHING_PAUSED") == "true" {
		return 0, nil
	}
	now := time.Now().UTC()
	return a.dispatch(ctx, now.Add(-recoveryLookback), now)
}

// DispatchDue replaces the former minute TypeScript publisher. It first
// settles posts whose workflow stopped mid-publication, then starts stable
// post workflows; all provider sends remain in the publishing worker.
func (a *RecoveryActivities) DispatchDue(ctx context.Context) (int, error) {
	if os.Getenv("PUBLISHING_PAUSED") == "true" {
		return 0, nil
	}
	// A failed sweep must not stop due posts from starting; the job reports both.
	released, sweep := a.ReleaseStalled(ctx)
	started, err := a.dispatch(ctx, time.Time{}, time.Now().UTC())
	return released + started, errors.Join(sweep, err)
}

// ReleaseStalled settles claimed posts whose workflow run has closed without
// recording an outcome (for example after exhausting its database retries).
// A post that may have reached its provider becomes UNKNOWN_DELIVERY; one
// that never did is queued again. A running workflow is left alone.
func (a *RecoveryActivities) ReleaseStalled(ctx context.Context) (int, error) {
	posts, err := a.store.ListStalledPosts(ctx, time.Now().Add(-stalledAfter), recoveryBatchSize)
	if err != nil {
		return 0, err
	}
	released := 0
	for _, post := range posts {
		running, err := a.scheduler.Running(ctx, post.ID, post.RunID)
		if err != nil {
			return released, err
		}
		if running {
			continue
		}
		outcome, err := a.store.ReleaseStalled(ctx, post.ID, post.RunID)
		if err != nil {
			return released, err
		}
		if outcome != "" {
			released++
			slog.WarnContext(ctx, "stalled publication released", "post", post.ID, "organization", post.OrganizationID, "outcome", outcome)
		}
	}
	return released, nil
}

func (a *RecoveryActivities) dispatch(ctx context.Context, since, now time.Time) (int, error) {
	total := 0
	var afterScheduled time.Time
	afterID := ""
	for range recoveryMaxPages {
		posts, err := a.store.ListRecoverablePostsAfter(ctx, since, now, afterScheduled, afterID, recoveryBatchSize)
		if err != nil {
			return total, err
		}
		if len(posts) == 0 {
			break
		}
		for _, post := range posts {
			if err := a.scheduler.EnsureStarted(ctx, ScheduleInput{
				OrganizationID: post.OrganizationID, PostID: post.ID, ScheduledFor: post.ScheduledFor,
			}); err != nil {
				return total, err
			}
			total++
		}
		if len(posts) < recoveryBatchSize {
			break
		}
		last := posts[len(posts)-1]
		afterScheduled, afterID = last.ScheduledFor, last.ID
	}
	return total, nil
}
