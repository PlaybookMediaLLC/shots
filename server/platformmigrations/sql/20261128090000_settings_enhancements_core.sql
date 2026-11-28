-- Settings enhancements (Phase 1 & 2): configurable randomization window on social_set,
-- personal authoring & automation email preferences on user_preference, and
-- workspace weekly posting goal & server-side video processing default on workspace_settings.

ALTER TABLE social_set
  ADD COLUMN IF NOT EXISTS "naturalPostingWindowMinutes" SMALLINT NOT NULL DEFAULT 10
    CONSTRAINT social_set_natural_window_check CHECK ("naturalPostingWindowMinutes" BETWEEN 1 AND 15);

-- Preserve existing ±4 minute window for profiles that already enabled natural posting times.
UPDATE social_set
  SET "naturalPostingWindowMinutes" = 4
  WHERE "naturalPostingTimes" = true AND "naturalPostingWindowMinutes" = 10;

ALTER TABLE user_preference
  ADD COLUMN IF NOT EXISTS "automationEmails" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "postFailureAlerts" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "postSummaryEmails" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "useFilenameAsCaption" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS "weeklyPostingGoal" INTEGER NULL
    CONSTRAINT workspace_settings_weekly_posting_goal_check CHECK ("weeklyPostingGoal" IS NULL OR ("weeklyPostingGoal" BETWEEN 1 AND 1000)),
  ADD COLUMN IF NOT EXISTS "processVideosOnServer" BOOLEAN NOT NULL DEFAULT true;
