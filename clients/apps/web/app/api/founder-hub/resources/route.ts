import { founderHubResourceActionContract } from '@/lib/api/contracts/founder-hub-resources'
import { route } from '@/lib/api/route'
import { requireFounderHubSettingsAccess } from '@/lib/auth/founder-hub'
import { backendSDK } from '@/lib/backend/sdk'

/** Apply an authenticated library operation through the original domain rules in Shots' database. */
export const POST = route(founderHubResourceActionContract, {
  auth: async ({ request }) => requireFounderHubSettingsAccess(request.headers),
  handler: async ({ access, body }) =>
    backendSDK({ ...access, organizationId: '' }).founderHubResourceAction(body),
})
