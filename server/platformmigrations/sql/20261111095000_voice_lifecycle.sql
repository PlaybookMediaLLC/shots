-- Voice note lifecycle (docs/plans/voice-capture-implementation.md, A1).
-- Additive: older code ignores both columns.

-- When the voice sweep first saw the owner gone from the workspace. Their live
-- notes are deleted 30 days later (owner decision 6); a member added back in
-- time keeps them.
ALTER TABLE "voice_note" ADD COLUMN "ownerRemovedAt" timestamp(3);
CREATE INDEX "voice_note_ownerRemovedAt_idx" ON "voice_note" ("ownerRemovedAt")
  WHERE "deletedAt" IS NULL AND "ownerRemovedAt" IS NOT NULL;

-- When storage confirmed a deleted or failed run's object is gone. The sweep
-- retries every such run without it, so a purge that failed after the
-- database commit is never forgotten.
ALTER TABLE "voice_audio_run" ADD COLUMN "objectPurgedAt" timestamp(3);
CREATE INDEX "voice_audio_run_objectPurgedAt_idx" ON "voice_audio_run" ("updatedAt")
  WHERE "objectPurgedAt" IS NULL AND "status" IN ('deleted', 'failed');
