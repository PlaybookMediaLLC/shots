import {
  getFounderHubDeviceCommandContract,
  finishFounderHubDeviceCommandContract,
} from '@/lib/api/contracts/founder-hub-devices'
import { route } from '@/lib/api/route'
import {
  requireFounderHubSettingsAccess,
  requireFounderHubDeviceAccess,
} from '@/lib/auth/founder-hub'
import { backendSDK } from '@/lib/backend/sdk'

/** Read private device state. */
export const GET = route(getFounderHubDeviceCommandContract, {
  auth: async ({ request }) => requireFounderHubSettingsAccess(request.headers),
  handler: async ({ access, params }) =>
    backendSDK({ ...access, organizationId: '' }).getFounderHubDeviceCommand(params.id),
})

/** Execute an authenticated, bounded native settings operation. */
export const PATCH = route(finishFounderHubDeviceCommandContract, {
  auth: async ({ request }) => requireFounderHubDeviceAccess(request.headers),
  handler: async ({ access, params, body }) =>
    backendSDK({ ...access, organizationId: '' }).finishFounderHubDeviceCommand(params.id, body),
})
