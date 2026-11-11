-- Voice commands (docs/plans/voice-capture-and-evidence-plan.md 5.4): the
-- outcome a confirm stored, so a resent confirm returns it (K11), and when the
-- row was last sent to the model, for the per-member parse limit. Additive:
-- older code ignores both columns, and they can stay after a rollback.
ALTER TABLE "voice_command" ADD COLUMN "outcome" text
  CHECK ("outcome" IN ('scheduled', 'pending_approval', 'draft'));
ALTER TABLE "voice_command" ADD COLUMN "parsedAt" timestamp(3);
CREATE INDEX "voice_command_ownerUserId_parsedAt_idx" ON "voice_command" ("ownerUserId", "parsedAt");
