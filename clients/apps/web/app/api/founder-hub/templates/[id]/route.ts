import { updateFounderHubTemplateContract } from '@/lib/api/contracts/founder-hub-templates'
import { route } from '@/lib/api/route'
import { requireFounderHubSettingsAccess } from '@/lib/auth/founder-hub'
import { backendSDK } from '@/lib/backend/sdk'

/** Save a conditional template change without trusting a client-supplied native header. */
export const PATCH = route(updateFounderHubTemplateContract, {
  auth: async ({ request }) => requireFounderHubSettingsAccess(request.headers),
  handler: async ({ access, params, body, request }) =>
    backendSDK({ ...access, organizationId: '' }).updateFounderHubTemplate(
      params.id,
      body,
      request.headers.has('authorization')
    ),
})
