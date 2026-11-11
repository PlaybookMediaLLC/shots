-- Redeploys, rollbacks and superseded deployments (voice capture and evidence
-- plan, fixes F3 and F4). Additive: older code ignores both columns and its
-- inserts take their defaults, so they can stay after a rollback.

-- A deployment compares its commit with earlier ones of its source and
-- environment. Existing rows were all treated as new releases.
ALTER TABLE "deployment_event"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'new' CHECK ("kind" IN ('new', 'redeploy', 'rollback')),
  ADD COLUMN "deployedAt" TIMESTAMP(3);

-- The provider's deployment time orders deployments. Existing rows were ordered
-- by arrival, which stays their order.
UPDATE "deployment_event" SET "deployedAt" = "createdAt";
ALTER TABLE "deployment_event"
  ALTER COLUMN "deployedAt" SET NOT NULL,
  ALTER COLUMN "deployedAt" SET DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "deployment_event_sourceAppId_environment_deployedAt_idx"
  ON "deployment_event"("sourceAppId", "environment", "deployedAt");
