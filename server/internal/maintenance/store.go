// Package maintenance runs platform maintenance directly against the application
// database. Prisma remains the schema authority; this package never creates tables.
package maintenance

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"time"

	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/notifications"
	"github.com/PlaybookMediaLLC/screenshot-studio/services/internal/webhooks"
	"github.com/lucsky/cuid"
)

type ObjectDeleter interface {
	Delete(context.Context, string, string) error
	// RecordDeletion writes a deletion-ledger entry outside the database.
	RecordDeletion(ctx context.Context, requestedAt time.Time, id string, record []byte) error
}

// uploadAborter discards the parts of a multipart upload that never finished.
type uploadAborter interface {
	AbortUpload(ctx context.Context, organizationID, key, uploadID string) error
}

// ProductEvents does the side effects of product events that take more than
// SQL: GitHub reads, screenshots, and captures. It reports false for an event
// it does not own.
type ProductEvents interface {
	HandleOutboxEvent(ctx context.Context, eventID, organizationID, eventType, aggregateID string) (bool, error)
}

type SocialAnalyticsCollector interface {
	CollectSocialAnalytics(context.Context) (int, error)
}

type dueAnalyticsCollector interface {
	CollectDueAnalytics(context.Context) (int, error)
}

// SocialTokenRefresher renews connected channels' expiring OAuth tokens.
type SocialTokenRefresher interface {
	RefreshSocialTokens(context.Context) (int, error)
}

type Store struct {
	Analytics   SocialAnalyticsCollector
	Tokens      SocialTokenRefresher
	Activity    *notifications.Service
	DB          *sql.DB
	RetentionDB *sql.DB
	Objects     ObjectDeleter
	Drains      *DrainSender
	Mail        *Mailer
	Events      ProductEvents
	// Onboarding stops a workspace's onboarding run before its data is purged.
	Onboarding OnboardingCanceller
	// Webhooks delivers outbound customer webhooks (RFC 024).
	Webhooks *webhooks.Dispatcher
}

// OnboardingCanceller stops a workspace's running onboarding workflow.
type OnboardingCanceller interface {
	Cancel(ctx context.Context, organizationID string) error
}

// Run executes a maintenance job under its PostgreSQL advisory lock, returning
// (0, nil) immediately if another replica already holds the lock.
func (s *Store) Run(ctx context.Context, job string) (int, error) {
	return s.run(ctx, job, false)
}

// RunWait executes a maintenance job under its PostgreSQL advisory lock,
// waiting for an in-flight holder to release it so explicit/on-demand triggers
// (such as Temporal runs or E2E helpers) execute a fresh pass instead of
// skipping on lock contention.
func (s *Store) RunWait(ctx context.Context, job string) (int, error) {
	return s.run(ctx, job, true)
}

func (s *Store) run(ctx context.Context, job string, wait bool) (int, error) {
	handlers := map[string]func(context.Context) (int, error){
		"frontend-deployments": func(ctx context.Context) (int, error) {
			if p, ok := s.Events.(interface {
				PollFrontends(context.Context) (int, error)
			}); ok {
				return p.PollFrontends(ctx)
			}
			return 0, nil
		},
		"tenant-outbox": s.Outbox, "outbox-retention": s.OutboxRetention, "audit-drains": s.AuditDrains,
		"communications": s.Communications, "workspace-cleanup": s.WorkspaceCleanup,
		"audit-retention":        s.AuditRetention,
		"notification-retention": s.NotificationRetention,
		"notifications":          s.Notifications,
		"notifications-maintain": s.NotificationsMaintain,
		"account-deletions":      s.AccountDeletions,
		"automation-reminders":   s.AutomationReminders,
		"webhooks":               s.DeliverWebhooks,
		"asset-cleanup":          s.AssetCleanup,
		"voice-cleanup":          s.VoiceCleanup,
		"voice-commands":         s.VoiceCommands,
		"social-analytics":       s.runSocialAnalytics,
		"social-token-refresh": func(ctx context.Context) (int, error) {
			if s.Tokens == nil {
				return 0, nil
			}
			return s.Tokens.RefreshSocialTokens(ctx)
		},
	}
	handler, ok := handlers[job]
	if !ok {
		return 0, fmt.Errorf("unknown maintenance job")
	}
	if wait {
		return s.WithLockWait(ctx, job, handler)
	}
	return s.WithLock(ctx, job, handler)
}

func (s *Store) runSocialAnalytics(ctx context.Context) (int, error) {
	if s.Analytics == nil {
		return 0, nil
	}
	total := 0
	if due, ok := s.Analytics.(dueAnalyticsCollector); ok {
		n, err := due.CollectDueAnalytics(ctx)
		total += n
		if err != nil {
			return total, err
		}
	}
	m, err := s.Analytics.CollectSocialAnalytics(ctx)
	return total + m, err
}

// WithLock runs fn under the per-job PostgreSQL session advisory lock used to
// serialize maintenance across worker replicas and retries. If another replica
// holds the lock, it returns (0, nil) without invoking fn.
func (s *Store) WithLock(ctx context.Context, job string, fn func(context.Context) (int, error)) (int, error) {
	return s.withLock(ctx, job, false, fn)
}

// WithLockWait runs fn under the per-job PostgreSQL session advisory lock,
// polling with capped backoff until the lock is free or ctx ends. Connections
// are returned to the pool between attempts so waiting never pins a DB slot.
func (s *Store) WithLockWait(ctx context.Context, job string, fn func(context.Context) (int, error)) (int, error) {
	return s.withLock(ctx, job, true, fn)
}

func (s *Store) withLock(ctx context.Context, job string, wait bool, fn func(context.Context) (int, error)) (int, error) {
	var conn *sql.Conn
	backoff := 100 * time.Millisecond
	var timer *time.Timer
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	for {
		var err error
		conn, err = s.DB.Conn(ctx)
		if err != nil {
			return 0, err
		}
		var locked bool
		if err = conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1, 0))`, "maintenance/"+job).Scan(&locked); err != nil {
			_ = conn.Close()
			return 0, err
		}
		if locked {
			break
		}
		_ = conn.Close()
		if !wait {
			return 0, nil
		}
		if timer == nil {
			timer = time.NewTimer(backoff)
		} else {
			timer.Reset(backoff)
		}
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-timer.C:
		}
		backoff = min(backoff*2, time.Second)
	}
	defer conn.Close()
	defer func() {
		unlockCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := conn.ExecContext(unlockCtx, `SELECT pg_advisory_unlock(hashtextextended($1, 0))`, "maintenance/"+job); err != nil {
			// Discard a connection whose session lock cannot be released.
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
	}()
	return fn(ctx)
}

func transaction(ctx context.Context, db *sql.DB, f func(*sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = f(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func audit(ctx context.Context, tx *sql.Tx, org, action, entityType, entityID, outcome string, metadata any) error {
	id := cuid.New()
	body, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO audit_log (id,"organizationId","requestId","actorType","actorDisplay",action,outcome,"entityType","entityId",metadata,"searchText") VALUES ($1,$2,$3,'SERVICE','temporal-maintenance',$4,$5::"AuditOutcome",$6,$3,$7,$8)`, id, org, entityID, action, outcome, entityType, body, action+" temporal-maintenance "+entityType+" "+entityID)
	if err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT id FROM audit_drain WHERE "organizationId"=$1 AND enabled`, org)
	if err != nil {
		return err
	}
	var drains []string
	for rows.Next() {
		var d string
		if err = rows.Scan(&d); err != nil {
			rows.Close()
			return err
		}
		drains = append(drains, d)
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(drains) == 0 {
		return err
	}
	outbox := cuid.New()
	if _, err = tx.ExecContext(ctx, `INSERT INTO audit_outbox (id,"auditLogId") VALUES ($1,$2)`, outbox, id); err != nil {
		return err
	}
	for _, d := range drains {
		if _, err = tx.ExecContext(ctx, `INSERT INTO audit_drain_delivery (id,"drainId","outboxId","updatedAt") VALUES ($1,$2,$3,now())`, cuid.New(), d, outbox); err != nil {
			return err
		}
	}
	return nil
}

func operational(ctx context.Context, db *sql.DB, org string) (bool, error) {
	var ok bool
	err := db.QueryRowContext(ctx, `SELECT NOT EXISTS (SELECT 1 FROM workspace_deletion WHERE "organizationId"=$1 AND status <> 'CANCELLED')`, org).Scan(&ok)
	return ok, err
}

func ids(ctx context.Context, db *sql.DB, query string, args ...any) ([]string, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		result = append(result, id)
	}
	return result, rows.Err()
}

// DeliverWebhooks drains queued outbound webhooks and returns immediately when
// idle rather than holding a worker slot and Postgres lock for a full minute.
func (s *Store) DeliverWebhooks(ctx context.Context) (int, error) {
	if s.Webhooks == nil {
		return 0, nil
	}
	return s.Webhooks.Drain(ctx, 45*time.Second)
}
