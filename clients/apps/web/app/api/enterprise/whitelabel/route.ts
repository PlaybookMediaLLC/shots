import { getWhitelabelContract, updateWhitelabelContract } from '@/lib/api/contracts/whitelabel'
import { route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { getAuditRequestMetadata } from '@/lib/audit/request'
import { backendSDK } from '@/lib/backend/sdk'

/** The organization's branding. */
export const GET = route(getWhitelabelContract, {
  auth: organizationAccess('workspace:read', { scope: 'requested' }),
  handler: async ({ access }) => backendSDK(access).getWhitelabel(),
})

/** Change the branding; the backend checks the plan. */
export const PUT = route(updateWhitelabelContract, {
  auth: organizationAccess('brand:manage', { scope: 'requested', sensitive: true }),
  handler: async ({ access, body, request }) => {
    const { organizationId: _organizationId, ...settings } = body
    return backendSDK(access).updateWhitelabel(settings, getAuditRequestMetadata(request.headers))
  },
})
