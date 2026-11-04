import {
  deletePermissionGroupContract,
  updatePermissionGroupContract,
} from '@/lib/api/contracts/permission-groups'
import { route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { getAuditRequestMetadata } from '@/lib/audit/request'
import { backendSDK } from '@/lib/backend/sdk'

/** Change a group; the backend checks the plan. */
export const PUT = route(updatePermissionGroupContract, {
  auth: organizationAccess('member:update_role', { scope: 'requested', sensitive: true }),
  handler: async ({ access, body, params, request }) =>
    backendSDK(access).updatePermissionGroup(
      params.groupId,
      {
        deniedPermissions: body.deniedPermissions,
        isDefault: body.isDefault,
        name: body.name,
      },
      getAuditRequestMetadata(request.headers)
    ),
})

/** Delete a group and lift its restrictions, on any plan. */
export const DELETE = route(deletePermissionGroupContract, {
  auth: organizationAccess('member:update_role', { scope: 'requested', sensitive: true }),
  handler: async ({ access, params, request }) => {
    await backendSDK(access).deletePermissionGroup(
      params.groupId,
      getAuditRequestMetadata(request.headers)
    )
    return undefined
  },
})
