-- The outbox-retention maintenance job deletes delivered work events after 30
-- days. This index holds only the rows it may prune, so each batch skips the
-- activity and domain events kept for good. The predicate matches
-- prunableOutbox in server/internal/maintenance/outbox.go.
CREATE INDEX outbox_event_retention ON outbox_event ("deliveredAt") WHERE "deliveredAt" IS NOT NULL AND "deadLetteredAt" IS NULL AND (type LIKE 'webhook.%' OR type IN ('github.observation','capture_job.dispatch','capture_connection.finish','release_automation.dispatch','release_automation.cancel','asset.deleted'));
