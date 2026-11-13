-- A post sent to a network's app as a draft (a TikTok app draft): delivered,
-- but the person finishes and posts it in the app, so it is never published.
ALTER TYPE "ScheduledPostStatus" ADD VALUE IF NOT EXISTS 'SENT_TO_APP';
