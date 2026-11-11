CREATE TABLE platform_founder_hub_template (
  id text PRIMARY KEY,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "templateId" text NOT NULL,
  content jsonb NOT NULL,
  pinned boolean NOT NULL DEFAULT false,
  seeded boolean NOT NULL DEFAULT false,
  "pinOrder" integer,
  version integer NOT NULL DEFAULT 1,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "deletedAt" timestamptz,
  UNIQUE ("userId", "templateId")
);
ALTER TABLE platform_founder_hub_user ADD COLUMN "templatesInitialized" boolean NOT NULL DEFAULT false;
