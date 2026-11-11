import { createFounderHubDeviceCommandContract } from '@/lib/api/contracts/founder-hub-devices'
import { route } from '@/lib/api/route'
import { requireFounderHubSettingsAccess } from '@/lib/auth/founder-hub'
import { backendSDK } from '@/lib/backend/sdk'

/** Execute an authenticated, bounded native settings operation. */
export const POST = route(createFounderHubDeviceCommandContract, {
  auth: async ({ request }) => requireFounderHubSettingsAccess(request.headers),
  handler: async ({ access, body }) =>
    backendSDK({ ...access, organizationId: '' }).createFounderHubDeviceCommand(body),
})
