-- Existing libraries can be linked only by an explicit identity migration, never by email.
CREATE TABLE platform_founder_hub_user (
  "userId" TEXT PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
  "accountUserId" UUID NOT NULL UNIQUE
);
CREATE TABLE platform_founder_hub_workspace (
  "organizationId" TEXT PRIMARY KEY REFERENCES organization (id) ON DELETE CASCADE,
  "workspaceId" UUID NOT NULL UNIQUE
);
