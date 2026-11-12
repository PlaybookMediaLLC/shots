-- Where a person heard about Shots, answered when they created their first
-- workspace. One row per person: the first answer is kept. Deleting the
-- account deletes the answer. The organization ID is deliberately not a
-- foreign key: like a creation receipt's, it outlives a workspace purge.
CREATE TABLE platform_signup_source (
  id text PRIMARY KEY,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "organizationId" text NOT NULL,
  "source" text NOT NULL,
  "detail" varchar(200),
  "createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_signup_source_source_check" CHECK ("source" IN (
    'search', 'ai_assistant', 'x', 'linkedin', 'youtube', 'tiktok_instagram', 'reddit',
    'product_hunt_hacker_news', 'friend_colleague', 'newsletter_blog_podcast',
    'event_community', 'other'
  )),
  CONSTRAINT "platform_signup_source_detail_check" CHECK ("detail" IS NULL OR "source" = 'other')
);
CREATE UNIQUE INDEX platformsignupsource_user_id ON platform_signup_source ("userId");
