-- F7: a scheduled post records who queued it and, for a draft post, who
-- approved the version it carries. Existing rows stay null. A workspace can
-- refuse approval by a draft's last editor; existing workspaces keep allowing it.
ALTER TABLE "scheduled_post" ADD COLUMN "scheduledByUserId" TEXT;
ALTER TABLE "scheduled_post" ADD COLUMN "approvedByUserId" TEXT;
ALTER TABLE "scheduled_post" ADD COLUMN "approvedVersion" INTEGER;
ALTER TABLE "content_draft_settings" ADD COLUMN "allowSelfApproval" BOOLEAN NOT NULL DEFAULT true;
