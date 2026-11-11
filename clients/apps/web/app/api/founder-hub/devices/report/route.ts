import { reportFounderHubDeviceContract } from '@/lib/api/contracts/founder-hub-devices'
import { route } from '@/lib/api/route'
import { requireFounderHubDeviceAccess } from '@/lib/auth/founder-hub'
import { backendSDK } from '@/lib/backend/sdk'

/** Execute an authenticated, bounded native settings operation. */
export const POST = route(reportFounderHubDeviceContract, {
  auth: async ({ request }) => requireFounderHubDeviceAccess(request.headers),
  handler: async ({ access, body }) =>
    backendSDK({ ...access, organizationId: '' }).reportFounderHubDevice(body),
})
