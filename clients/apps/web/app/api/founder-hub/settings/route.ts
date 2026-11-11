import {
  getFounderHubSettingsContract,
  updateFounderHubSettingsContract,
} from '@/lib/api/contracts/founder-hub'
import { route } from '@/lib/api/route'
import { requireFounderHubSettingsAccess } from '@/lib/auth/founder-hub'
import { backendSDK } from '@/lib/backend/sdk'

/** Read private preferences through either a Shots browser session or the native gateway. */
export const GET = route(getFounderHubSettingsContract, {
  auth: async ({ request }) => requireFounderHubSettingsAccess(request.headers),
  handler: async ({ access }) =>
    backendSDK({ ...access, organizationId: '' }).getFounderHubSettings(),
})

/** Save private preferences after Shots verifies the live session. */
export const PATCH = route(updateFounderHubSettingsContract, {
  auth: async ({ request }) => requireFounderHubSettingsAccess(request.headers),
  handler: async ({ access, body, request }) =>
    backendSDK({ ...access, organizationId: '' }).updateFounderHubSettings(
      body,
      request.headers.has('authorization')
    ),
})
