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

// Serialize a job across replicas and manual invocations, including activity
// retries. Session locks disappear if a worker loses its database connection.
func (s *Store) Run(ctx context.Context, job string) (int, error) {
	handlers := map[string]func(context.Context) (int, error){
		"frontend-deployments": func(ctx context.Context) (int, error) {
			if p, ok := s.Events.(interface {
				PollFrontends(context.Context) (int, error)
			}); ok {
				return p.PollFrontends(ctx)
			}
			return 0, nil
		},
		"tenant-outbox": s.Outbox, "audit-drains": s.AuditDrains,
		"communications": s.Communications, "workspace-cleanup": s.WorkspaceCleanup,
		"audit-retention":   s.AuditRetention,
		"notifications":     s.Notifications,
		"account-deletions": s.AccountDeletions,
		"webhooks":          s.DeliverWebhooks,
		"asset-cleanup":     s.AssetCleanup,
		"voice-cleanup":     s.VoiceCleanup,
		"social-analytics": func(ctx context.Context) (int, error) {
			if s.Analytics == nil {
				return 0, nil
			}
			return s.Analytics.CollectSocialAnalytics(ctx)
		},
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
	conn, err := s.DB.Conn(ctx)
	if err != nil {
		return 0, err
	}
	defer conn.Close()
	var locked bool
	if err = conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1, 0))`, "maintenance/"+job).Scan(&locked); err != nil {
		return 0, err
	}
	if !locked {
		return 0, nil
	}
	defer func() {
		unlockCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := conn.ExecContext(unlockCtx, `SELECT pg_advisory_unlock(hashtextextended($1, 0))`, "maintenance/"+job); err != nil {
			// Discard a connection whose session lock cannot be released.
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
	}()
	return handler(ctx)
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

// DeliverWebhooks fans out and delivers outbound webhooks for most of a
// minute; the schedule starts it again once it ends.
func (s *Store) DeliverWebhooks(ctx context.Context) (int, error) {
	if s.Webhooks == nil {
		return 0, nil
	}
	return s.Webhooks.Run(ctx, 50*time.Second)
}
