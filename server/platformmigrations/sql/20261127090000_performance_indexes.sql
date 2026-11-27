-- +migrate no-transaction

-- Partial cleanup & scheduling due-sweep indexes (BE-05, BE-07).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "asset_pending_failed_updatedAt_idx"
  ON "asset" ("updatedAt")
  WHERE "status" IN ('PENDING', 'FAILED');

CREATE INDEX CONCURRENTLY IF NOT EXISTS "scheduled_post_due_idx"
  ON "scheduled_post" ("scheduledFor")
  WHERE "status" = 'SCHEDULED';

-- Composite keyset / list ordering indexes (BE-07).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "scheduled_post_organizationId_scheduledFor_id_idx"
  ON "scheduled_post" ("organizationId", "scheduledFor" DESC, "id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "release_organizationId_updatedAt_id_idx"
  ON "release" ("organizationId", "updatedAt" DESC, "id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "content_draft_organizationId_pinnedAt_id_idx"
  ON "content_draft" ("organizationId", "pinnedAt" DESC, "id" DESC)
  WHERE "pinnedAt" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "content_draft_organizationId_createdAt_id_idx"
  ON "content_draft" ("organizationId", "createdAt" DESC, "id" DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "analytics_snapshot_latest_subject_idx"
  ON "analytics_snapshot" ("connectionId", "kind", "subjectId", "observedAt" DESC, "collectedAt" DESC, "id" DESC);

-- High-churn foreign-key indexes to eliminate parent-delete sequential scans (BE-07).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_log_actorUserId_idx"
  ON "audit_log" ("actorUserId")
  WHERE "actorUserId" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "scheduled_post_assetId_idx"
  ON "scheduled_post" ("assetId")
  WHERE "assetId" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "surface_capture_assetId_idx"
  ON "surface_capture" ("assetId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "campaign_asset_assetId_idx"
  ON "campaign_asset" ("assetId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "session_activeOrganizationId_idx"
  ON "session" ("activeOrganizationId")
  WHERE "activeOrganizationId" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "capture_job_appConnectionId_idx"
  ON "capture_job" ("appConnectionId")
  WHERE "appConnectionId" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "capture_recipe_appConnectionId_idx"
  ON "capture_recipe" ("appConnectionId")
  WHERE "appConnectionId" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "source_app_githubInstallationId_idx"
  ON "source_app" ("githubInstallationId")
  WHERE "githubInstallationId" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "content_batch_socialSetId_idx"
  ON "content_batch" ("socialSetId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_delivery_organizationId_idx"
  ON "webhook_delivery" ("organizationId");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "project_version_organizationId_idx"
  ON "project_version" ("organizationId");

-- Drop single-column prefix indexes fully covered by existing composite indexes.
DROP INDEX CONCURRENTLY IF EXISTS "member_organizationId_idx";
DROP INDEX CONCURRENTLY IF EXISTS "invitation_organizationId_idx";

-- Trigram GIN indexes for substring search (BE-07).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "audit_log_searchText_trgm_idx"
  ON "audit_log" USING gin ("searchText" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "asset_objectKey_trgm_idx"
  ON "asset" USING gin ("objectKey" gin_trgm_ops);
