import { defaultAc, defaultRoles } from 'better-auth/plugins/organization/access'

export const organizationRoles = [
  'owner',
  'admin',
  'creator',
  'approver',
  'publisher',
  'writer_publisher',
  'viewer',
] as const

export type OrganizationRole = (typeof organizationRoles)[number]

export const permissions = [
  'workspace:read',
  'workspace:update',
  'billing:manage',
  'connection:manage',
  'workspace:delete',
  'workspace:transfer_ownership',
  'member:read',
  'member:invite',
  'member:remove',
  'member:update_role',
  'invitation:read',
  'invitation:revoke',
  'audit:read',
  'audit:export',
  'audit:manage',
  'identity:manage',
  'brand:manage',
  'release:create',
  'release:approve',
  'artifact:read',
  'artifact:edit',
  'publish:manage',
  'support:manage',
] as const

export type Permission = (typeof permissions)[number]

const rolePermissions: Record<OrganizationRole, readonly Permission[]> = {
  owner: permissions,
  admin: [
    'workspace:read',
    'workspace:update',
    'connection:manage',
    'member:read',
    'member:invite',
    'member:remove',
    'member:update_role',
    'invitation:read',
    'invitation:revoke',
    'audit:read',
    'audit:export',
    'audit:manage',
    'identity:manage',
    'brand:manage',
    'release:create',
    'release:approve',
    'artifact:read',
    'artifact:edit',
    'publish:manage',
  ],
  creator: ['workspace:read', 'member:read', 'release:create', 'artifact:read', 'artifact:edit'],
  approver: ['workspace:read', 'member:read', 'artifact:read', 'release:approve'],
  publisher: ['workspace:read', 'member:read', 'artifact:read', 'publish:manage'],
  writer_publisher: [
    'workspace:read',
    'member:read',
    'release:create',
    'artifact:read',
    'artifact:edit',
    'publish:manage',
  ],
  viewer: ['workspace:read', 'member:read', 'artifact:read'],
}

export const betterAuthOrganizationRoles = {
  owner: defaultRoles.owner,
  admin: defaultRoles.admin,
  member: defaultRoles.member,
  creator: defaultAc.newRole({ ac: ['read'] }),
  approver: defaultAc.newRole({ ac: ['read'] }),
  publisher: defaultAc.newRole({ ac: ['read'] }),
  writer_publisher: defaultAc.newRole({ ac: ['read'] }),
  viewer: defaultAc.newRole({ ac: ['read'] }),
}

export function getRolePermissions(role: string): readonly Permission[] {
  return rolePermissions[normalizeOrganizationRole(role)]
}

export function hasPermission(role: string, permission: Permission): boolean {
  return rolePermissions[normalizeOrganizationRole(role)].includes(permission)
}

/**
 * What a member may do here: their role's permission, unless their permission
 * group denies it. Groups only subtract. Use this wherever a member's access is
 * known, so a page offers what the server will accept.
 */
export function accessAllows(
  access: { deniedPermissions: readonly string[]; role: string },
  permission: Permission
): boolean {
  return hasPermission(access.role, permission) && !access.deniedPermissions.includes(permission)
}

export function normalizeOrganizationRole(role: string): OrganizationRole {
  if (role === 'member') {
    return 'viewer'
  }

  return organizationRoles.includes(role as OrganizationRole)
    ? (role as OrganizationRole)
    : 'viewer'
}

/**
 * Whether a sensitive action still needs Shots two-factor. An account with no
 * Shots password cannot enroll an authenticator, so its sign-in provider
 * (Google, GitHub or SSO) carries the second factor. Unknown accounts fail closed.
 */
export function needsShotsTwoFactor(
  twoFactorEnabled: boolean,
  providerIds: readonly string[] | null
): boolean {
  if (twoFactorEnabled) return false
  return !providerIds?.length || providerIds.includes('credential')
}

export function isSupportedOrganizationRole(role: string): boolean {
  return role === 'member' || organizationRoles.includes(role as OrganizationRole)
}
