import { createFounderHubCRMConnectSessionContract } from '@/lib/api/contracts/founder-hub'
import { route } from '@/lib/api/route'
import { requireFounderHubSettingsAccess } from '@/lib/auth/founder-hub'
import { backendSDK } from '@/lib/backend/sdk'

/** Create an authenticated Nango Connect session. */
export const POST = route(createFounderHubCRMConnectSessionContract, {
  auth: async ({ request }) => requireFounderHubSettingsAccess(request.headers),
  handler: async ({ access, body }) =>
    backendSDK({ ...access, organizationId: '' }).createFounderHubCRMConnectSession(body),
})
