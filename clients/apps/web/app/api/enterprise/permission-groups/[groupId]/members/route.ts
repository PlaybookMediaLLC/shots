import { setPermissionGroupMembersContract } from '@/lib/api/contracts/permission-groups'
import { route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { getAuditRequestMetadata } from '@/lib/audit/request'
import { backendSDK } from '@/lib/backend/sdk'

/** Make these members exactly the group's members. */
export const PUT = route(setPermissionGroupMembersContract, {
  auth: organizationAccess('member:update_role', { scope: 'requested', sensitive: true }),
  handler: async ({ access, body, params, request }) =>
    backendSDK(access).setPermissionGroupMembers(
      params.groupId,
      body.memberIds,
      getAuditRequestMetadata(request.headers)
    ),
})
