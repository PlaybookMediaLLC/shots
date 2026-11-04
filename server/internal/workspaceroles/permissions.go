package workspaceroles

import "slices"

// Permissions names what a permission group may deny. It mirrors `permissions`
// in clients/apps/web/lib/auth/permissions.ts, which owns their meaning;
// TestPermissionsMatchWeb fails if the two lists drift.
var Permissions = []string{
	"workspace:read", "workspace:update", "billing:manage", "connection:manage", "workspace:delete",
	"workspace:transfer_ownership", "member:read", "member:invite", "member:remove", "member:update_role",
	"invitation:read", "invitation:revoke", "audit:read", "audit:export", "audit:manage", "identity:manage",
	"brand:manage", "release:create", "release:approve", "artifact:read", "artifact:edit", "publish:manage",
	"support:manage",
}

// ValidPermission reports whether name is a known permission.
func ValidPermission(name string) bool { return slices.Contains(Permissions, name) }
