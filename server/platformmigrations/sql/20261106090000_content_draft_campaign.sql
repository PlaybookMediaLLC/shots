-- The campaign an edited campaign visual was published from. A creative
-- rendered by a workflow or the campaign studio opens in the editor, and the
-- export becomes an ordinary Publish draft that still names its campaign, so
-- review and scheduling stay in Publish without losing where the work began.
-- Additive and nullable: existing drafts and older code ignore the column,
-- and rollback is DROP COLUMN.
ALTER TABLE content_draft ADD COLUMN "campaignId" text;

CREATE INDEX "content_draft_organizationId_campaignId_idx"
  ON "content_draft" ("organizationId", "campaignId");
