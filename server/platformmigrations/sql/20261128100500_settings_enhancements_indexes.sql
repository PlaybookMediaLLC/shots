-- +migrate no-transaction
-- Concurrent indexes for settings enhancements (publish group summaries & automation reminders).

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_scheduled_post_publish_group
  ON scheduled_post ("organizationId", "publishGroupId")
  WHERE "publishGroupId" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_scheduled_post_org_created
  ON scheduled_post ("organizationId", "createdAt");
