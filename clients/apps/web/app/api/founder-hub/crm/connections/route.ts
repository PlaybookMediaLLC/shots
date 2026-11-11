import {
  getFounderHubCRMConnectionsContract,
  registerFounderHubCRMConnectionContract,
} from '@/lib/api/contracts/founder-hub'
import { route } from '@/lib/api/route'
import { requireFounderHubSettingsAccess } from '@/lib/auth/founder-hub'
import { backendSDK } from '@/lib/backend/sdk'

/** Read the authenticated account's CRM connections. */
export const GET = route(getFounderHubCRMConnectionsContract, {
  auth: async ({ request }) => requireFounderHubSettingsAccess(request.headers),
  handler: async ({ access }) =>
    backendSDK({ ...access, organizationId: '' }).getFounderHubCRMConnections(),
})

/** Verify a Nango connection and register it for native CRM consumers. */
export const POST = route(registerFounderHubCRMConnectionContract, {
  auth: async ({ request }) => requireFounderHubSettingsAccess(request.headers),
  handler: async ({ access, body }) =>
    backendSDK({ ...access, organizationId: '' }).registerFounderHubCRMConnection(body),
})
