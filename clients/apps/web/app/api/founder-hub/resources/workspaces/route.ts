import { founderHubShareWorkspacesContract } from '@/lib/api/contracts/founder-hub-resources'
import { route } from '@/lib/api/route'
import { requireFounderHubSettingsAccess } from '@/lib/auth/founder-hub'
import { backendSDK } from '@/lib/backend/sdk'

/** Read the person's current Shots workspace destinations. */
export const GET = route(founderHubShareWorkspacesContract, {
  auth: async ({ request }) => requireFounderHubSettingsAccess(request.headers),
  handler: async ({ access }) =>
    backendSDK({ ...access, organizationId: '' }).founderHubShareWorkspaces(),
})
