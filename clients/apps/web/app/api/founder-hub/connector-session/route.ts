import { getFounderHubConnectorSessionContract } from '@/lib/api/contracts/founder-hub'
import { route } from '@/lib/api/route'
import { requireFounderHubConnectorAccess } from '@/lib/auth/founder-hub'

/** Verify delegated connector authority exclusively for the trusted Hub service. */
export const GET = route(getFounderHubConnectorSessionContract, {
  auth: async ({ request }) => requireFounderHubConnectorAccess(request.headers),
  handler: async ({ access }) => access,
})
