import { getCurrentKeyInfoContract } from '@/lib/api/contracts/auth-key'
import { route } from '@/lib/api/route'
import { apiKeyOnlyAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Redacted identity, scopes, and workspace of the calling workspace API key. */
export const GET = route(getCurrentKeyInfoContract, {
  auth: apiKeyOnlyAccess(getCurrentKeyInfoContract.access),
  handler: async ({ access }) => backendSDK(access).getCurrentAPIKeyInfo(),
})
