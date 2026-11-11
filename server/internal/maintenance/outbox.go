package maintenance

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

func (s *Store) Outbox(ctx context.Context) (int, error) {
	// A crashed eighth attempt must become dead-lettered, not stranded forever.
	_, err := s.DB.ExecContext(ctx, `UPDATE outbox_event SET "processingAt"=NULL WHERE "deliveredAt" IS NULL AND "deadLetteredAt" IS NULL AND "processingAt" < now()-interval '10 minutes'`)
	if err != nil {
		return 0, err
	}
	// Legacy review intents stay pending until their recipient migration commits.
	// Outbound webhook events (webhook.*) belong to the webhooks job.
	// GitHub enrichment retries at exponentially spaced offsets from acceptance
	// (1, 2, 4, ... 64 minutes), independent of worker restarts. Other event
	// families retain their existing retry behavior.
	candidates, err := ids(ctx, s.DB, `SELECT id FROM outbox_event WHERE "deliveredAt" IS NULL AND type NOT LIKE 'webhook.%' AND NOT (notification_version=0 AND type IN ('campaign_posts.submitted','campaign_posts.decided')) AND "deadLetteredAt" IS NULL AND "processingAt" IS NULL AND (type <> 'github.observation' OR attempts=0 OR "createdAt" <= now() - power(2,LEAST(attempts,8))*interval '30 seconds') ORDER BY "createdAt" LIMIT 100`)
	if err != nil {
		return 0, err
	}
	count := 0
	for _, id := range candidates {
		var org, kind, aggregate, resource string
		var attempts int
		var created time.Time
		err = s.DB.QueryRowContext(ctx, `UPDATE outbox_event e SET "processingAt"=now(),attempts=attempts+1 WHERE id=$1 AND "deliveredAt" IS NULL AND type NOT LIKE 'webhook.%' AND NOT (notification_version=0 AND type IN ('campaign_posts.submitted','campaign_posts.decided')) AND "deadLetteredAt" IS NULL AND "processingAt" IS NULL AND (type <> 'github.observation' OR attempts=0 OR "createdAt" <= now() - power(2,LEAST(attempts,8))*interval '30 seconds') AND (("aggregateType"='asset' AND type='asset.deleted') OR NOT EXISTS(SELECT 1 FROM workspace_deletion w WHERE w."organizationId"=e."organizationId" AND w.status <> 'CANCELLED')) RETURNING "organizationId",type,"aggregateType","aggregateId",attempts,"createdAt"`, id).Scan(&org, &kind, &aggregate, &resource, &attempts, &created)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return count, err
		}
		var failure error
		switch {
		case attempts > 8:
			failure = fmt.Errorf("outbox retry budget exhausted after worker interruption")
		case strings.HasPrefix(kind, "activity."):
		// Notification delivery has independent processing state.
		case aggregate == "asset" && kind == "asset.deleted":
			var key string
			var uploadID sql.NullString
			failure = s.DB.QueryRowContext(ctx, `SELECT "objectKey","uploadId" FROM asset WHERE id=$1 AND "organizationId"=$2 AND status='DELETED'`, resource, org).Scan(&key, &uploadID)
			// The ledger entry comes first, so no bytes are gone that the ledger does not name.
			if failure == nil {
				failure = s.recordDeletion(ctx, DeletionRecord{Kind: "asset", OrganizationID: org, ID: resource, EventID: id, RequestedAt: created.UTC()})
			}
			// An unfinished multipart upload's parts are not the object; discard them too.
			if aborter, ok := s.Objects.(uploadAborter); failure == nil && uploadID.Valid && ok {
				failure = aborter.AbortUpload(ctx, org, key, uploadID.String)
			}
			if failure == nil {
				failure = s.Objects.Delete(ctx, org, key)
			}
		case s.Events != nil && productEvent(kind):
			_, failure = s.Events.HandleOutboxEvent(ctx, id, org, kind, resource)
		default:
			var eligible bool
			if aggregate == "asset" && (kind == "asset.uploaded" || kind == "asset.generated") {
				failure = s.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM asset WHERE id=$1 AND "organizationId"=$2 AND status='UPLOADED')`, resource, org).Scan(&eligible)
			} else if aggregate == "release" {
				failure = s.DB.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM release WHERE id=$1 AND "organizationId"=$2 AND status <> 'CANCELLED')`, resource, org).Scan(&eligible)
			}
			if failure == nil && !eligible {
				failure = fmt.Errorf("tenant resource is no longer eligible for dispatch")
			}
		}
		if ctx.Err() != nil {
			return count, ctx.Err()
		}
		err = transaction(ctx, s.DB, func(tx *sql.Tx) error {
			if failure == nil {
				if _, e := tx.ExecContext(ctx, `UPDATE outbox_event SET "deliveredAt"=now(),"lastError"=NULL,"processingAt"=NULL WHERE id=$1`, id); e != nil {
					return e
				}
				return audit(ctx, tx, org, "product.outbox_dispatched", "outbox_event", id, "SUCCEEDED", nil)
			}
			// Persist a stable error code; network errors may include credentialed URLs.
			if _, e := tx.ExecContext(ctx, `UPDATE outbox_event SET "processingAt"=NULL,"lastError"='DISPATCH_FAILED',"deadLetteredAt"=CASE WHEN attempts>=8 THEN now() ELSE NULL END WHERE id=$1`, id); e != nil {
				return e
			}
			if attempts >= 8 {
				return audit(ctx, tx, org, "product.outbox_dead_lettered", "outbox_event", id, "FAILED", map[string]any{"attempts": attempts, "failureCode": "DISPATCH_FAILED"})
			}
			return nil
		})
		if err != nil {
			return count, err
		}
		if failure == nil {
			count++
		}
	}
	return count, nil
}

// prunableOutbox selects the event families nothing reads once delivered:
// work items whose effects are recorded elsewhere. Activity and domain events
// are kept, because notification receipts read their scope from them and
// idempotent intake (releases, reviews, comments) finds earlier requests by
// their keys. The outbox_event_retention index has the same predicate.
const prunableOutbox = `"deliveredAt" IS NOT NULL AND "deadLetteredAt" IS NULL AND (type LIKE 'webhook.%' OR type IN ('github.observation','capture_job.dispatch','capture_connection.finish','release_automation.dispatch','release_automation.cancel','asset.deleted'))`

const outboxRetentionBatch = 1000

// OutboxRetention deletes prunable events delivered more than 30 days ago,
// a batch at a time; the audit log keeps each dispatch. Undelivered and
// dead-lettered events stay, as do events notification fan-out has not read.
func (s *Store) OutboxRetention(ctx context.Context) (int, error) {
	deleted := 0
	for {
		result, err := s.DB.ExecContext(ctx, `DELETE FROM outbox_event WHERE id IN (SELECT id FROM outbox_event WHERE `+prunableOutbox+` AND "deliveredAt" < now() - interval '30 days' AND (notification_version=0 OR notification_fanned) LIMIT $1)`, outboxRetentionBatch)
		if err != nil {
			return deleted, err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return deleted, err
		}
		deleted += int(count)
		if count < outboxRetentionBatch {
			return deleted, nil
		}
	}
}

// productEvent reports whether the product handles an event's side effect.
func productEvent(kind string) bool {
	switch kind {
	case "source_change.collected", "release.ingested", "source_app.connected", "deployment.succeeded",
		"campaign_posts.submitted", "campaign_posts.decided", "release_automation.dispatch", "release_automation.cancel", "github.observation",
		"capture_job.dispatch", "capture_connection.finish":
		return true
	}
	return false
}
