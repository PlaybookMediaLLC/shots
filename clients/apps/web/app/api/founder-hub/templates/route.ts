import { getFounderHubTemplatesContract } from '@/lib/api/contracts/founder-hub-templates'
import { route } from '@/lib/api/route'
import { requireFounderHubSettingsAccess } from '@/lib/auth/founder-hub'
import { backendSDK } from '@/lib/backend/sdk'

/** List private templates using a live Shots browser or desktop session. */
export const GET = route(getFounderHubTemplatesContract, {
  auth: async ({ request }) => requireFounderHubSettingsAccess(request.headers),
  handler: async ({ access, query }) =>
    backendSDK({ ...access, organizationId: '' }).getFounderHubTemplates(query),
})
