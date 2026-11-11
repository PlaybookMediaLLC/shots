-- Voice capture (docs/plans/voice-capture-and-evidence-plan.md 5.2-5.4).
-- Additive: older code ignores these tables and the new draft column, and they
-- can stay after a rollback. Notes are private to their owner; a deleted note
-- keeps its row as a tombstone so an offline phone cannot recreate it.

CREATE TABLE "voice_note" (
  "id" text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "ownerUserId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "clientNoteId" text NOT NULL CHECK (char_length("clientNoteId") BETWEEN 1 AND 100),
  "title" text NOT NULL DEFAULT '' CHECK (char_length("title") <= 120),
  "projectId" text REFERENCES "project"("id") ON DELETE SET NULL,
  "recordedAt" timestamp(3) NOT NULL,
  "recordedTimeZone" text NOT NULL CHECK (char_length("recordedTimeZone") BETWEEN 1 AND 64),
  "receivedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locale" text CHECK (char_length("locale") <= 35),
  "durationMs" integer CHECK ("durationMs" >= 0),
  "audioUploadConsent" boolean NOT NULL DEFAULT false,
  "revision" integer NOT NULL DEFAULT 1 CHECK ("revision" >= 1),
  "currentTranscriptRevisionId" text,
  "deletedAt" timestamp(3),
  -- When the voice sweep first saw the owner gone from the workspace. Their
  -- live notes are deleted 30 days later (owner decision 6); a member added
  -- back in time keeps them.
  "ownerRemovedAt" timestamp(3),
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "voice_note_organizationId_ownerUserId_clientNoteId_key"
  ON "voice_note" ("organizationId", "ownerUserId", "clientNoteId");
CREATE INDEX "voice_note_organizationId_ownerUserId_receivedAt_idx"
  ON "voice_note" ("organizationId", "ownerUserId", "receivedAt");
CREATE INDEX "voice_note_ownerRemovedAt_idx" ON "voice_note" ("ownerRemovedAt")
  WHERE "deletedAt" IS NULL AND "ownerRemovedAt" IS NOT NULL;

CREATE TABLE "voice_transcript_revision" (
  "id" text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "noteId" text NOT NULL REFERENCES "voice_note"("id") ON DELETE CASCADE,
  "clientRevisionId" text NOT NULL CHECK (char_length("clientRevisionId") BETWEEN 1 AND 100),
  "parentId" text REFERENCES "voice_transcript_revision"("id") ON DELETE SET NULL,
  "origin" text NOT NULL CHECK ("origin" IN ('on_device', 'remote', 'user_edit')),
  "locale" text CHECK (char_length("locale") <= 35),
  "engine" text CHECK (char_length("engine") <= 64),
  "text" text NOT NULL CHECK (char_length("text") <= 100000),
  "segments" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "redactedAt" timestamp(3),
  "createdByUserId" text NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- A redacted row holds no text: the purge path clears both together.
  CHECK ("redactedAt" IS NULL OR ("text" = '' AND "segments" = '[]'::jsonb))
);
CREATE UNIQUE INDEX "voice_transcript_revision_noteId_clientRevisionId_key"
  ON "voice_transcript_revision" ("noteId", "clientRevisionId");
CREATE INDEX "voice_transcript_revision_noteId_createdAt_idx"
  ON "voice_transcript_revision" ("noteId", "createdAt");
ALTER TABLE "voice_note" ADD CONSTRAINT "voice_note_currentTranscriptRevisionId_fkey"
  FOREIGN KEY ("currentTranscriptRevisionId") REFERENCES "voice_transcript_revision"("id") ON DELETE SET NULL;

CREATE TABLE "voice_audio_run" (
  "id" text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "noteId" text NOT NULL REFERENCES "voice_note"("id") ON DELETE CASCADE,
  "runIndex" integer NOT NULL CHECK ("runIndex" >= 0),
  "startOffsetMs" integer NOT NULL CHECK ("startOffsetMs" >= 0),
  "clientDurationMs" integer CHECK ("clientDurationMs" >= 0),
  "durationMs" integer CHECK ("durationMs" >= 0),
  "sampleRateHz" integer CHECK ("sampleRateHz" > 0),
  "contentType" text NOT NULL CHECK (char_length("contentType") BETWEEN 1 AND 100),
  "bytes" bigint NOT NULL CHECK ("bytes" > 0),
  "sha256" text NOT NULL CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  "objectKey" text NOT NULL UNIQUE,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'available', 'failed', 'deleted')),
  "failureReason" text,
  -- When storage confirmed a deleted or failed run's object is gone. The
  -- sweep retries every such run without it, so a purge that failed after the
  -- database commit is never forgotten.
  "objectPurgedAt" timestamp(3),
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "voice_audio_run_noteId_runIndex_key" ON "voice_audio_run" ("noteId", "runIndex");
CREATE INDEX "voice_audio_run_status_updatedAt_idx" ON "voice_audio_run" ("status", "updatedAt");
CREATE INDEX "voice_audio_run_objectPurgedAt_idx" ON "voice_audio_run" ("updatedAt")
  WHERE "objectPurgedAt" IS NULL AND "status" IN ('deleted', 'failed');

CREATE TABLE "voice_settings" (
  "organizationId" text PRIMARY KEY REFERENCES "organization"("id") ON DELETE CASCADE,
  "voiceNotes" boolean NOT NULL DEFAULT false,
  "audioUpload" boolean NOT NULL DEFAULT false,
  "draftGeneration" boolean NOT NULL DEFAULT false,
  "voiceCommands" boolean NOT NULL DEFAULT false,
  "updatedByUserId" text,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "voice_member_settings" (
  "id" text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "remoteTextConsentAt" timestamp(3),
  "voiceCommands" boolean NOT NULL DEFAULT false,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Voice commands send transcript text to a model, so they need the disclosure.
  CHECK (NOT "voiceCommands" OR "remoteTextConsentAt" IS NOT NULL)
);
CREATE UNIQUE INDEX "voice_member_settings_organizationId_userId_key"
  ON "voice_member_settings" ("organizationId", "userId");

CREATE TABLE "voice_command" (
  "id" text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "ownerUserId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "noteId" text NOT NULL UNIQUE REFERENCES "voice_note"("id") ON DELETE CASCADE,
  "transcriptRevisionId" text NOT NULL REFERENCES "voice_transcript_revision"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'waiting' CHECK ("status" IN ('waiting', 'proposed', 'confirmed', 'expired', 'withdrawn', 'failed')),
  "action" text NOT NULL DEFAULT 'none' CHECK ("action" IN ('schedule_post', 'create_draft', 'none')),
  "platform" text,
  "text" text CHECK (char_length("text") <= 2000),
  "localTime" text CHECK ("localTime" ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  "timeZone" text NOT NULL CHECK (char_length("timeZone") BETWEEN 1 AND 64),
  "scheduledFor" timestamp(3),
  "channelConnectionId" text,
  "guessed" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "flags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "notice" text,
  "attempts" integer NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "nextAttemptAt" timestamp(3),
  "expiresAt" timestamp(3),
  "contentDraftId" text,
  "scheduledPostId" text,
  "failureReason" text,
  -- The outcome a confirm stored, so a resent confirm returns it (K11).
  "outcome" text CHECK ("outcome" IN ('scheduled', 'pending_approval', 'draft')),
  -- When the row was last sent to the model, for the per-member parse limit.
  "parsedAt" timestamp(3),
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "voice_command_status_nextAttemptAt_idx" ON "voice_command" ("status", "nextAttemptAt");
CREATE INDEX "voice_command_status_expiresAt_idx" ON "voice_command" ("status", "expiresAt");
CREATE INDEX "voice_command_ownerUserId_parsedAt_idx" ON "voice_command" ("ownerUserId", "parsedAt");

ALTER TABLE "content_draft" ADD COLUMN "sourceVoiceRevisionId" text;
