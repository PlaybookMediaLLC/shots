package maintenance

import (
	"context"
	"database/sql"
	"fmt"
)

func (s *Store) AuditRetention(ctx context.Context) (int, error) {
	if s.RetentionDB == nil {
		return 0, fmt.Errorf("AUDIT_RETENTION_DATABASE_URL is required")
	}
	organizations, err := ids(ctx, s.RetentionDB, `SELECT id FROM organization ORDER BY id`)
	if err != nil {
		return 0, err
	}
	total := 0
	for _, org := range organizations {
		err = transaction(ctx, s.RetentionDB, func(tx *sql.Tx) error {
			// The append-only trigger on audit_log admits deletes only here.
			if _, e := tx.ExecContext(ctx, `SET LOCAL shots.audit_retention = 'on'`); e != nil {
				return e
			}
			// Re-evaluate legal hold in the deletion statement; no cached policy list.
			result, e := tx.ExecContext(ctx, `DELETE FROM audit_log a WHERE "organizationId"=$1 AND NOT EXISTS (SELECT 1 FROM audit_retention_policy p WHERE p."organizationId"=$1 AND p."legalHold") AND "createdAt" < now() - make_interval(days => COALESCE((SELECT "retentionDays" FROM audit_retention_policy WHERE "organizationId"=$1),90))`, org)
			if e != nil {
				return e
			}
			n, e := result.RowsAffected()
			if e != nil {
				return e
			}
			if n > 0 {
				if e = audit(ctx, tx, org, "product.audit_retention_purged", "audit_log", org, "SUCCEEDED", map[string]any{"deletedCount": n}); e != nil {
					return e
				}
			}
			total += int(n)
			return nil
		})
		if err != nil {
			return total, err
		}
	}
	return total, nil
}

// heldNotification is true while the notification's workspace is on legal hold.
const heldNotification = `EXISTS (SELECT 1 FROM audit_retention_policy p WHERE p."organizationId"=n."organizationId" AND p."legalHold")`

// NotificationRetention deletes notifications and their delivery records 90
// days after they were created, read or not, a batch at a time. A workspace
// legal hold pauses it, as it pauses the audit purge. Rows another transaction
// holds, such as a delivery a sender is claiming, wait for the next run, and
// a claimed delivery is never deleted. Deliveries go first: a delivery without
// its inbox row is normal, an inbox row without its delivery cannot be opened.
func (s *Store) NotificationRetention(ctx context.Context) (int, error) {
	deliveries, err := s.deleteBatches(ctx, `DELETE FROM platform_notification_delivery WHERE status <> 'CLAIMED' AND id IN (SELECT n.id FROM platform_notification_delivery n WHERE n.created_at < now() - interval '90 days' AND n.status <> 'CLAIMED' AND NOT `+heldNotification+` LIMIT $1 FOR UPDATE SKIP LOCKED)`)
	if err != nil {
		return deliveries, err
	}
	inbox, err := s.deleteBatches(ctx, `DELETE FROM platform_notification_inbox WHERE id IN (SELECT n.id FROM platform_notification_inbox n WHERE n.created_at < now() - interval '90 days' AND NOT `+heldNotification+` LIMIT $1 FOR UPDATE SKIP LOCKED)`)
	return deliveries + inbox, err
}
