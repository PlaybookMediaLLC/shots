CREATE TABLE "platform_founder_hub_settings" (
  "id" text PRIMARY KEY,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "deviceId" text NOT NULL DEFAULT '',
  "deviceName" text NOT NULL DEFAULT '',
  "values" jsonb NOT NULL DEFAULT '{}',
  "version" integer NOT NULL DEFAULT 1,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("userId", "deviceId")
);
