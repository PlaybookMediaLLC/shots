-- Delete a published post (docs/scheduling/post-delete): when the live post
-- was deleted through Shots, and one receipt per deleted part, so a retried
-- delete never calls a part that is done.
ALTER TABLE "scheduled_post" ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE TABLE "post_deletion" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "scheduledPostId" TEXT NOT NULL REFERENCES "scheduled_post"("id") ON DELETE CASCADE,
  "key" TEXT NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('post', 'repost')),
  "remoteId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'done', 'failed', 'unsupported')),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "failureCode" TEXT,
  "requestedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "post_deletion_scheduledPostId_key_key" ON "post_deletion" ("scheduledPostId", "key");
