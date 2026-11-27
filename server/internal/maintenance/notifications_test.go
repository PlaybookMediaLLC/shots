package maintenance

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/notifications"
)

func TestNotificationsRunByDefault(t *testing.T) {
	db, err := sql.Open("pgx", "postgres://localhost/unused")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := &Store{Activity: &notifications.Service{DB: db}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	for _, legacyPaused := range []string{"", "true", "false"} {
		t.Run("legacyPaused="+legacyPaused, func(t *testing.T) {
			t.Setenv("PLATFORM_ACTIVITY_LEGACY_PAUSED", legacyPaused)
			_, err := store.Notifications(ctx)
			if legacyPaused == "false" {
				if err != nil {
					t.Fatalf("dispatcher ran alongside legacy senders: %v", err)
				}
			} else if !errors.Is(err, context.Canceled) {
				t.Fatalf("dispatcher did not reach database with cancelled context: %v", err)
			}
			_, err = store.NotificationsMaintain(ctx)
			if legacyPaused == "false" {
				if err != nil {
					t.Fatalf("maintain ran alongside legacy senders: %v", err)
				}
			} else if !errors.Is(err, context.Canceled) {
				t.Fatalf("maintain did not reach database with cancelled context: %v", err)
			}
		})
	}
	// Verify Store.Run routes "notifications-maintain" to WithLock rather than unknown job.
	store.DB = db
	if _, err := store.Run(ctx, "notifications-maintain"); !errors.Is(err, context.Canceled) {
		t.Fatalf("Store.Run(notifications-maintain) = %v, want context.Canceled", err)
	}
}

type reviewEvents struct{ calls int }

func (e *reviewEvents) HandleOutboxEvent(context.Context, string, string, string, string) (bool, error) {
	e.calls++
	return true, nil
}

func TestOutboxPreservesLegacyReviewIntentsUntilCutover(t *testing.T) {
	s, _ := setup(t)
	handler := &reviewEvents{}
	s.Events = handler
	event(t, s, "legacy-submitted", "a", "campaign", "campaign_posts.submitted")
	event(t, s, "legacy-decided", "a", "campaign", "campaign_posts.decided")
	event(t, s, "current", "a", "campaign", "campaign_posts.submitted")
	exec(t, s.DB, `UPDATE outbox_event SET attempts=3 WHERE id='legacy-decided'`)
	exec(t, s.DB, `UPDATE outbox_event SET notification_version=1 WHERE id='current'`)
	for range 10 {
		run(t, s, "tenant-outbox")
	}
	if handler.calls != 1 {
		t.Fatalf("unconverted reviews reached the retired sender: %d", handler.calls)
	}
	expect(t, s.DB, 2, `SELECT count(*) FROM outbox_event WHERE notification_version=0 AND "deliveredAt" IS NULL AND "deadLetteredAt" IS NULL AND "processingAt" IS NULL`)
	expect(t, s.DB, 0, `SELECT attempts FROM outbox_event WHERE id='legacy-submitted'`)
	expect(t, s.DB, 3, `SELECT attempts FROM outbox_event WHERE id='legacy-decided'`)
	// ImportLegacy advances this version atomically with its recipient migration.
	exec(t, s.DB, `UPDATE outbox_event SET notification_version=1 WHERE notification_version=0`)
	if n := run(t, s, "tenant-outbox"); n != 2 {
		t.Fatalf("converted reviews did not resume: %d", n)
	}
}
