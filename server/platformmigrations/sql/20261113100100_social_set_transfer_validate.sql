-- Validates the keys 20261113100000 added NOT VALID. Validation reads each
-- table without blocking writes to it.
ALTER TABLE content_draft VALIDATE CONSTRAINT "content_draft_socialSetId_fkey";
ALTER TABLE content_draft_tag VALIDATE CONSTRAINT "content_draft_tag_organizationId_socialSetId_fkey";
ALTER TABLE content_draft_finisher VALIDATE CONSTRAINT "content_draft_finisher_organizationId_socialSetId_fkey";
ALTER TABLE social_set_writing_sample VALIDATE CONSTRAINT "social_set_writing_sample_organizationId_socialSetId_fkey";
