import { deleteFounderHubCRMConnectionContract } from '@/lib/api/contracts/founder-hub'
import { route } from '@/lib/api/route'
import { requireFounderHubSettingsAccess } from '@/lib/auth/founder-hub'
import { backendSDK } from '@/lib/backend/sdk'

/** Delete an owned Nango connection and its native lookup row. */
export const DELETE = route(deleteFounderHubCRMConnectionContract, {
  auth: async ({ request }) => requireFounderHubSettingsAccess(request.headers),
  handler: async ({ access, params, query }) =>
    backendSDK({ ...access, organizationId: '' }).deleteFounderHubCRMConnection(
      query.provider,
      params.id
    ),
})
