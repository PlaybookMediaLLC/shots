import { getFounderHubDevicesContract } from '@/lib/api/contracts/founder-hub-devices'
import { route } from '@/lib/api/route'
import { requireFounderHubSettingsAccess } from '@/lib/auth/founder-hub'
import { backendSDK } from '@/lib/backend/sdk'

/** Read private device state. */
export const GET = route(getFounderHubDevicesContract, {
  auth: async ({ request }) => requireFounderHubSettingsAccess(request.headers),
  handler: async ({ access }) =>
    backendSDK({ ...access, organizationId: '' }).getFounderHubDevices(),
})
