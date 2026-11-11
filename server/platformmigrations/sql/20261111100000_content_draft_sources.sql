-- Where a draft came from, beside campaignId: the release whose screenshots
-- and summary it was made from, and the campaign post whose copy it took.
-- They keep approval and claim evidence reachable from the draft. Both are
-- set once at creation; drafts made before stay NULL.
ALTER TABLE content_draft ADD COLUMN "releaseId" text;
ALTER TABLE content_draft ADD COLUMN "campaignPostId" text;
