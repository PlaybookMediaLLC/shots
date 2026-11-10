import { getFounderHubSessionContract } from '@/lib/api/contracts/founder-hub'
import { route } from '@/lib/api/route'
import { requireFounderHubAccess } from '@/lib/auth/founder-hub'

/** Resolve current permissions and stable library IDs using a native OAuth credential. */
export const GET = route(getFounderHubSessionContract, {
  auth: async ({ request }) => requireFounderHubAccess(request.headers),
  handler: async ({ access }) => access,
})
