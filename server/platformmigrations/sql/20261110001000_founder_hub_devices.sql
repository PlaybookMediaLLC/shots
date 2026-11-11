CREATE TABLE platform_founder_hub_device (
  id text PRIMARY KEY,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "deviceId" text NOT NULL,
  name text NOT NULL,
  report jsonb NOT NULL,
  "reportedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("userId", "deviceId")
);

CREATE TABLE platform_founder_hub_device_command (
  id text PRIMARY KEY,
  "userId" text NOT NULL,
  "deviceId" text NOT NULL,
  kind text NOT NULL,
  argument text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  error text NOT NULL DEFAULT '',
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz NOT NULL,
  FOREIGN KEY ("userId", "deviceId") REFERENCES platform_founder_hub_device("userId", "deviceId") ON DELETE CASCADE
);
CREATE INDEX platform_founder_hub_device_command_pending ON platform_founder_hub_device_command("userId", "deviceId", status);
