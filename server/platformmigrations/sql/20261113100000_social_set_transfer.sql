-- Moving a social set to another workspace (RFC 024) changes the set's
-- organizationId. Its drafts, tags, finishers and writing samples follow it
-- through these composite keys. Accounts never follow: the move takes them out
-- of the set first. Ent models these columns but not the key actions.
ALTER TABLE content_draft
  DROP CONSTRAINT "content_draft_socialSetId_fkey",
  ADD CONSTRAINT "content_draft_socialSetId_fkey" FOREIGN KEY ("organizationId", "socialSetId")
    REFERENCES social_set("organizationId", id) ON UPDATE CASCADE;
ALTER TABLE content_draft_tag
  DROP CONSTRAINT "content_draft_tag_organizationId_socialSetId_fkey",
  ADD CONSTRAINT "content_draft_tag_organizationId_socialSetId_fkey" FOREIGN KEY ("organizationId", "socialSetId")
    REFERENCES social_set("organizationId", id) ON UPDATE CASCADE;
ALTER TABLE content_draft_finisher
  DROP CONSTRAINT "content_draft_finisher_organizationId_socialSetId_fkey",
  ADD CONSTRAINT "content_draft_finisher_organizationId_socialSetId_fkey" FOREIGN KEY ("organizationId", "socialSetId")
    REFERENCES social_set("organizationId", id) ON UPDATE CASCADE;
ALTER TABLE social_set_writing_sample
  DROP CONSTRAINT "social_set_writing_sample_organizationId_socialSetId_fkey",
  ADD CONSTRAINT "social_set_writing_sample_organizationId_socialSetId_fkey" FOREIGN KEY ("organizationId", "socialSetId")
    REFERENCES social_set("organizationId", id) ON UPDATE CASCADE;
