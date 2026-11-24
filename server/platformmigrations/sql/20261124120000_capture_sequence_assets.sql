-- Additive migration for Phase 3 multi-shot AI capture sequence assets.
-- All statements are idempotent and online-safe.
SET LOCAL lock_timeout = '5s';

ALTER TABLE capture_job
  ADD COLUMN IF NOT EXISTS "sequenceAssetIds" JSONB;
