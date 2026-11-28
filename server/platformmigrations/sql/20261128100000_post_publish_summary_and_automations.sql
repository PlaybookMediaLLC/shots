-- Phase 2: Post Publish Summary grouping + Lifecycle Automation Email log.
-- Concurrent indexes on scheduled_post live in 20261128100500_settings_enhancements_indexes.sql.

ALTER TABLE scheduled_post
  ADD COLUMN IF NOT EXISTS "publishGroupId" text;

CREATE TABLE IF NOT EXISTS user_automation_email_log (
  id text PRIMARY KEY,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "organizationId" text NOT NULL,
  kind text NOT NULL,
  "windowKey" text NOT NULL,
  "providerReceipt" text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'PENDING',
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_automation_email_log_window
  ON user_automation_email_log ("userId", "organizationId", kind, "windowKey");

CREATE INDEX IF NOT EXISTS idx_user_automation_email_log_user_org_kind_created
  ON user_automation_email_log ("userId", "organizationId", kind, "createdAt");
