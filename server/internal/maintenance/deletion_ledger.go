package maintenance

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/lucsky/cuid"
)

// DeletionRecord is one deletion-ledger entry: what was deleted, when its
// deletion was requested, and the outbox event that carried the request. It
// holds IDs only, never content. The ledger lives in object storage, outside
// the database's backups, so a restore can replay deletions it would undo.
type DeletionRecord struct {
	Kind           string    `json:"kind"`
	OrganizationID string    `json:"organizationId"`
	ID             string    `json:"id"`
	EventID        string    `json:"eventId"`
	RequestedAt    time.Time `json:"requestedAt"`
}

func (s *Store) recordDeletion(ctx context.Context, record DeletionRecord) error {
	body, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return s.Objects.RecordDeletion(ctx, record.RequestedAt, record.EventID, body)
}

// ReplayDeletions deletes again what a database restore brought back: each
// ledger entry requested after the restore point. An asset becomes DELETED
// with an asset.deleted outbox event, so the outbox removes any bytes left;
// a record the restored database never had, or already deleted, is skipped.
// It reports how many records it deleted again.
func (s *Store) ReplayDeletions(ctx context.Context, records []DeletionRecord, restoredTo time.Time) (int, error) {
	replayed := 0
	for _, record := range records {
		if !record.RequestedAt.After(restoredTo) {
			continue
		}
		if record.Kind != "asset" {
			return replayed, fmt.Errorf("deletion ledger entry %s has unknown kind %q", record.EventID, record.Kind)
		}
		var changed int64
		err := transaction(ctx, s.DB, func(tx *sql.Tx) error {
			result, err := tx.ExecContext(ctx, `UPDATE asset SET status='DELETED',"updatedAt"=now() WHERE id=$1 AND "organizationId"=$2 AND status<>'DELETED'`, record.ID, record.OrganizationID)
			if err != nil {
				return err
			}
			if changed, err = result.RowsAffected(); err != nil || changed == 0 {
				return err
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO outbox_event (id, "organizationId", type, "aggregateType", "aggregateId", payload, "idempotencyKey")
				VALUES ($1, $2, 'asset.deleted', 'asset', $3, jsonb_build_object('assetId', $3::text), 'asset.deleted:' || $3)
				ON CONFLICT ("organizationId", "idempotencyKey") DO NOTHING`, cuid.New(), record.OrganizationID, record.ID); err != nil {
				return err
			}
			return audit(ctx, tx, record.OrganizationID, "product.asset_deletion_replayed", "asset", record.ID, "SUCCEEDED", map[string]any{"eventId": record.EventID})
		})
		if err != nil {
			return replayed, err
		}
		replayed += int(changed)
	}
	return replayed, nil
}
