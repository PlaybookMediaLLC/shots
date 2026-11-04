-- Per-organization permission groups (ent/schema/permission_group.go): named
-- sets of permissions subtracted from their members' roles. A member has at
-- most one group, and leaving the workspace removes the assignment.
CREATE TABLE "permission_group" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "deniedPermissions" JSONB NOT NULL DEFAULT '[]',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "permission_group_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "permission_group_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "permission_group_organizationId_name_key" ON "permission_group"("organizationId", "name");
CREATE UNIQUE INDEX "permission_group_organizationId_default_key" ON "permission_group"("organizationId") WHERE "isDefault";

CREATE TABLE "permission_group_member" (
    "memberId" TEXT NOT NULL,
    "permissionGroupId" TEXT NOT NULL,

    CONSTRAINT "permission_group_member_pkey" PRIMARY KEY ("memberId"),
    CONSTRAINT "permission_group_member_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "member"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "permission_group_member_permissionGroupId_fkey" FOREIGN KEY ("permissionGroupId") REFERENCES "permission_group"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "permission_group_member_permissionGroupId_idx" ON "permission_group_member"("permissionGroupId");
