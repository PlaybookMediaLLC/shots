-- A customer app that authenticated captures sign in to. Session state is an
-- authenticated envelope; the key lives in backend secrets, not here.
CREATE TABLE "platform_app_connection" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "sourceAppId" TEXT,
  "name" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "hosts" JSONB NOT NULL DEFAULT '[]',
  "loginHosts" JSONB NOT NULL DEFAULT '[]',
  "protectedPath" TEXT NOT NULL,
  "identitySelector" TEXT NOT NULL,
  "expectedAccount" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'CONNECTING',
  "stateCiphertext" TEXT,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "stateRevision" INTEGER NOT NULL DEFAULT 0,
  "validatedAt" TIMESTAMP(3),
  "stateExpiresAt" TIMESTAMP(3),
  "connectIntentId" TEXT,
  "connectUserId" TEXT,
  "connectSessionId" TEXT,
  "connectExpiresAt" TIMESTAMP(3),
  "connectPhase" TEXT,
  "failureCode" TEXT,
  "leaseJobId" TEXT,
  "leaseToken" BIGINT NOT NULL DEFAULT 0,
  "leaseExpiresAt" TIMESTAMP(3),
  "createdByUserId" TEXT NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_app_connection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "platform_app_connection_org_name_key" ON "platform_app_connection"("organizationId", "name");
ALTER TABLE "platform_app_connection" ADD CONSTRAINT "platform_app_connection_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform_app_connection" ADD CONSTRAINT "platform_app_connection_sourceAppId_fkey"
  FOREIGN KEY ("sourceAppId") REFERENCES "source_app"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The early capture tables become the one capture system. A recipe no longer
-- needs a source, and a job or attempt no longer needs a release: a deployment
-- or a test capture has none. Existing rows keep their values.
ALTER TABLE "capture_recipe"
  ALTER COLUMN "sourceAppId" DROP NOT NULL,
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "surfaceId" TEXT,
  ADD COLUMN "appConnectionId" TEXT,
  ADD COLUMN "definitionHash" TEXT,
  ADD COLUMN "createdByUserId" TEXT,
  ADD COLUMN "testedAt" TIMESTAMP(3);
ALTER TABLE "capture_recipe" ADD CONSTRAINT "capture_recipe_surfaceId_fkey"
  FOREIGN KEY ("surfaceId") REFERENCES "product_surface"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "capture_recipe" ADD CONSTRAINT "capture_recipe_appConnectionId_fkey"
  FOREIGN KEY ("appConnectionId") REFERENCES "platform_app_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "capture_job"
  ALTER COLUMN "releaseId" DROP NOT NULL,
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "phase" TEXT NOT NULL DEFAULT 'QUEUED',
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "surfaceId" TEXT,
  ADD COLUMN "appConnectionId" TEXT,
  ADD COLUMN "connectionGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deploymentEventId" TEXT,
  ADD COLUMN "expectedRevision" TEXT,
  ADD COLUMN "recipeHash" TEXT,
  ADD COLUMN "fencingToken" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "failureCode" TEXT,
  ADD COLUMN "deadlineAt" TIMESTAMP(3),
  ADD COLUMN "requestedByUserId" TEXT,
  ADD COLUMN "surfaceCaptureId" TEXT,
  ADD COLUMN "assetId" TEXT,
  ADD COLUMN "resumeCount" INTEGER NOT NULL DEFAULT 0;
UPDATE "capture_job" SET "phase" = "status"::text;
ALTER TABLE "capture_job" ADD CONSTRAINT "capture_job_surfaceId_fkey"
  FOREIGN KEY ("surfaceId") REFERENCES "product_surface"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "capture_job" ADD CONSTRAINT "capture_job_appConnectionId_fkey"
  FOREIGN KEY ("appConnectionId") REFERENCES "platform_app_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "capture_job" ADD CONSTRAINT "capture_job_deploymentEventId_fkey"
  FOREIGN KEY ("deploymentEventId") REFERENCES "deployment_event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "capture"
  ALTER COLUMN "releaseId" DROP NOT NULL,
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "attemptNumber" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "browserSessionId" TEXT,
  ADD COLUMN "browserClosedAt" TIMESTAMP(3),
  ADD COLUMN "observedRevision" TEXT,
  ADD COLUMN "fencingToken" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "refusedRequests" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "assetId" TEXT;
-- Number any existing attempts so each job's numbers are unique.
WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY "captureJobId" ORDER BY "createdAt", id) AS n FROM "capture"
)
UPDATE "capture" SET "attemptNumber" = numbered.n FROM numbered WHERE "capture".id = numbered.id;
CREATE UNIQUE INDEX "capture_job_attempt_key" ON "capture"("captureJobId", "attemptNumber");
-- Reclaiming abandoned browsers scans only the ones still open.
CREATE INDEX "capture_open_browser_idx" ON "capture"("startedAt")
  WHERE "browserSessionId" IS NOT NULL AND "browserClosedAt" IS NULL;
