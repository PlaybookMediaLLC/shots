import {
  createPermissionGroupContract,
  listPermissionGroupsContract,
} from '@/lib/api/contracts/permission-groups'
import { route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { getAuditRequestMetadata } from '@/lib/audit/request'
import { backendSDK } from '@/lib/backend/sdk'

/** The organization's permission groups. */
export const GET = route(listPermissionGroupsContract, {
  auth: organizationAccess('member:read', { scope: 'requested' }),
  handler: async ({ access }) => backendSDK(access).listPermissionGroups(),
})

/** Create a group; the backend checks the plan. */
export const POST = route(createPermissionGroupContract, {
  auth: organizationAccess('member:update_role', { scope: 'requested', sensitive: true }),
  handler: async ({ access, body, request }) =>
    backendSDK(access).createPermissionGroup(
      {
        deniedPermissions: body.deniedPermissions,
        isDefault: body.isDefault,
        name: body.name,
      },
      getAuditRequestMetadata(request.headers)
    ),
})
