-- RFC 007A: unattended first-factor email sign-in for authenticated capture.
-- No table here stores an email body, subject, link, code, cookie, or header:
-- a receipt keeps provider IDs and a recipient hash, and an attempt keeps IDs,
-- times, and a safe failure code.

-- The last automatic sign-in. "validatedAt" stays the last human
-- authorization, so automatic sign-ins never extend the 30-day cap.
ALTER TABLE "platform_app_connection" ADD COLUMN "lastAutoAuthenticatedAt" TIMESTAMP(3);

CREATE TABLE "capture_email_auth_config" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "recipientLocalPart" TEXT NOT NULL,
  "recipientDomain" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "recipeVersionId" TEXT,
  "expectedSenders" JSONB NOT NULL DEFAULT '[]',
  "autoReconnect" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "testedRevision" INTEGER,
  "lastTestedAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "lastFailureCode" TEXT,
  "createdByUserId" TEXT NOT NULL,
  "approvedByUserId" TEXT,
  "approvedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "capture_email_auth_config_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_email_auth_config_method_check" CHECK ("method" IN ('MAGIC_LINK', 'EMAIL_CODE')),
  CONSTRAINT "capture_email_auth_config_status_check" CHECK ("status" IN ('DRAFT', 'VERIFIED', 'PAUSED', 'REVOKED'))
);
CREATE UNIQUE INDEX "captureemailauthconfig_connection_id" ON "capture_email_auth_config"("connectionId");
CREATE UNIQUE INDEX "captureemailauthconfig_recipient_local_part_recipient_domain" ON "capture_email_auth_config"("recipientLocalPart", "recipientDomain");
CREATE INDEX "captureemailauthconfig_organization_id_connection_id" ON "capture_email_auth_config"("organizationId", "connectionId");
ALTER TABLE "capture_email_auth_config" ADD CONSTRAINT "capture_email_auth_config_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "capture_email_auth_config" ADD CONSTRAINT "capture_email_auth_config_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "platform_app_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "capture_auth_recipe_version" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "configId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "definition" JSONB NOT NULL,
  "definitionHash" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "capture_auth_recipe_version_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "captureauthrecipeversion_config_id_version" ON "capture_auth_recipe_version"("configId", "version");
ALTER TABLE "capture_auth_recipe_version" ADD CONSTRAINT "capture_auth_recipe_version_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "capture_auth_recipe_version" ADD CONSTRAINT "capture_auth_recipe_version_configId_fkey"
  FOREIGN KEY ("configId") REFERENCES "capture_email_auth_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "capture_email_auth_config" ADD CONSTRAINT "capture_email_auth_config_recipeVersionId_fkey"
  FOREIGN KEY ("recipeVersionId") REFERENCES "capture_auth_recipe_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "capture_auth_attempt" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "configId" TEXT NOT NULL,
  "configRevision" INTEGER NOT NULL,
  "recipeVersionId" TEXT NOT NULL,
  "recipeHash" TEXT NOT NULL,
  "connectionGeneration" INTEGER NOT NULL,
  "mode" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'ADMITTED',
  "browserSessionId" TEXT,
  "browserClosedAt" TIMESTAMP(3),
  "emailRequestedAt" TIMESTAMP(3),
  "emailReceivedAt" TIMESTAMP(3),
  "receiptId" TEXT,
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "fenceToken" BIGINT NOT NULL DEFAULT 0,
  "createdByUserId" TEXT,
  "triggerCaptureJobId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "capture_auth_attempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_auth_attempt_mode_check" CHECK ("mode" IN ('TEST', 'AUTO_RECOVER')),
  CONSTRAINT "capture_auth_attempt_state_check" CHECK ("state" IN ('ADMITTED', 'BROWSER_STARTING', 'CHALLENGE_REQUESTED', 'WAITING_FOR_EMAIL', 'EMAIL_MATCHED', 'APPLYING_CHALLENGE', 'VERIFYING', 'COMMITTING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED', 'HUMAN_REQUIRED'))
);
-- One automatic sign-in per connection at a time, enforced by the database.
CREATE UNIQUE INDEX "captureauthattempt_connection_id" ON "capture_auth_attempt"("connectionId")
  WHERE "state" IN ('ADMITTED','BROWSER_STARTING','CHALLENGE_REQUESTED','WAITING_FOR_EMAIL','EMAIL_MATCHED','APPLYING_CHALLENGE','VERIFYING','COMMITTING');
CREATE INDEX "captureauthattempt_organization_id_created_at" ON "capture_auth_attempt"("organizationId", "createdAt");
CREATE INDEX "captureauthattempt_connection_id_created_at" ON "capture_auth_attempt"("connectionId", "createdAt");
-- The cleanup sweep scans only browsers still open.
CREATE INDEX "capture_auth_attempt_open_browser_idx" ON "capture_auth_attempt"("deadlineAt")
  WHERE "browserSessionId" IS NOT NULL AND "browserClosedAt" IS NULL;
ALTER TABLE "capture_auth_attempt" ADD CONSTRAINT "capture_auth_attempt_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "capture_auth_attempt" ADD CONSTRAINT "capture_auth_attempt_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "platform_app_connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "capture_auth_attempt" ADD CONSTRAINT "capture_auth_attempt_configId_fkey"
  FOREIGN KEY ("configId") REFERENCES "capture_email_auth_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "capture_auth_attempt" ADD CONSTRAINT "capture_auth_attempt_recipeVersionId_fkey"
  FOREIGN KEY ("recipeVersionId") REFERENCES "capture_auth_recipe_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "capture_auth_attempt" ADD CONSTRAINT "capture_auth_attempt_triggerCaptureJobId_fkey"
  FOREIGN KEY ("triggerCaptureJobId") REFERENCES "capture_job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Receipts arrive before Shots knows the tenant, so organization is nullable.
CREATE TABLE "capture_inbound_receipt" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerEventId" TEXT NOT NULL,
  "providerEmailId" TEXT NOT NULL,
  "recipientHash" TEXT NOT NULL,
  "organizationId" TEXT,
  "configId" TEXT,
  "attemptId" TEXT,
  "state" TEXT NOT NULL DEFAULT 'RECEIVED',
  "failureCode" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "processedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "capture_inbound_receipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "capture_inbound_receipt_state_check" CHECK ("state" IN ('RECEIVED', 'ASSIGNED', 'CONSUMED', 'IGNORED', 'FAILED'))
);
CREATE UNIQUE INDEX "captureinboundreceipt_provider_provider_event_id" ON "capture_inbound_receipt"("provider", "providerEventId");
CREATE UNIQUE INDEX "captureinboundreceipt_provider_provider_email_id" ON "capture_inbound_receipt"("provider", "providerEmailId");
CREATE INDEX "captureinboundreceipt_attempt_id" ON "capture_inbound_receipt"("attemptId");
CREATE INDEX "captureinboundreceipt_expires_at" ON "capture_inbound_receipt"("expiresAt");
ALTER TABLE "capture_inbound_receipt" ADD CONSTRAINT "capture_inbound_receipt_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "capture_inbound_receipt" ADD CONSTRAINT "capture_inbound_receipt_attemptId_fkey"
  FOREIGN KEY ("attemptId") REFERENCES "capture_auth_attempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
