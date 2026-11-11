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

// ForRole mirrors the web authorization owner; the parity test guards the storage projection.
func ForRole(role string) []string {
	switch role {
	case "owner":
		return slices.Clone(Permissions)
	case "admin":
		return []string{"workspace:read", "workspace:update", "connection:manage", "member:read", "member:invite", "member:remove", "member:update_role", "invitation:read", "invitation:revoke", "audit:read", "audit:export", "audit:manage", "identity:manage", "brand:manage", "release:create", "release:approve", "artifact:read", "artifact:edit", "publish:manage"}
	case "creator":
		return []string{"workspace:read", "member:read", "release:create", "artifact:read", "artifact:edit"}
	case "approver":
		return []string{"workspace:read", "member:read", "artifact:read", "release:approve"}
	case "publisher":
		return []string{"workspace:read", "member:read", "artifact:read", "publish:manage"}
	case WriterPublisher:
		return []string{"workspace:read", "member:read", "release:create", "artifact:read", "artifact:edit", "publish:manage"}
	default:
		return []string{"workspace:read", "member:read", "artifact:read"}
	}
}
