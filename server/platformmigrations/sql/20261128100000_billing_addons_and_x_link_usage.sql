-- Workspace billing add-ons (starting with "x_links": $10/month for 40 X link posts / rolling 30 days),
-- durable rolling 30-day X link usage ledger, and stripped-link visibility on scheduled posts and attempts.

CREATE TABLE IF NOT EXISTS "workspace_addon" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "addonKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'canceled',
  "provider" TEXT NOT NULL DEFAULT 'stripe',
  "externalSubscriptionId" TEXT,
  "quotaLimit" INTEGER,
  "currentPeriodStart" TIMESTAMPTZ,
  "currentPeriodEnd" TIMESTAMPTZ,
  "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT FALSE,
  "graceUntil" TIMESTAMPTZ,
  "version" INTEGER NOT NULL DEFAULT 1,
  "lastSyncedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "workspace_addon_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workspace_addon_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspaceaddon_organizationId_addonKey"
  ON "workspace_addon" ("organizationId", "addonKey");

CREATE INDEX IF NOT EXISTS "workspaceaddon_externalSubscriptionId"
  ON "workspace_addon" ("externalSubscriptionId");

CREATE TABLE IF NOT EXISTS "x_link_post_usage" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "scheduledPostId" TEXT,
  "partKey" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "linkCount" INTEGER NOT NULL CHECK ("linkCount" > 0),
  "consumedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "refundedAt" TIMESTAMPTZ,
  CONSTRAINT "x_link_post_usage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "x_link_post_usage_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organization" ("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "xlinkpostusage_organizationId_idempotencyKey"
  ON "x_link_post_usage" ("organizationId", "idempotencyKey");

CREATE INDEX IF NOT EXISTS "xlinkpostusage_organizationId_consumedAt"
  ON "x_link_post_usage" ("organizationId", "consumedAt")
  WHERE "refundedAt" IS NULL;

ALTER TABLE "publication_attempt"
  ADD COLUMN IF NOT EXISTS "linksStrippedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "xLinkQuotaConsumed" BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE "scheduled_post"
  ADD COLUMN IF NOT EXISTS "xLinksStrippedCount" INTEGER NOT NULL DEFAULT 0;
