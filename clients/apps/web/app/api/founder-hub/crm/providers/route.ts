import { getFounderHubCRMProvidersContract } from '@/lib/api/contracts/founder-hub'
import { route } from '@/lib/api/route'
import { requireFounderHubSettingsAccess } from '@/lib/auth/founder-hub'
import { backendSDK } from '@/lib/backend/sdk'

/** Read supported CRM providers and configuration status. */
export const GET = route(getFounderHubCRMProvidersContract, {
  auth: async ({ request }) => requireFounderHubSettingsAccess(request.headers),
  handler: async ({ access }) =>
    backendSDK({ ...access, organizationId: '' }).getFounderHubCRMProviders(),
})
