import { getRequestId } from '@/lib/api/request-context'
import { revokeFounderHubSessionContract } from '@/lib/api/contracts/founder-hub'
import { route } from '@/lib/api/route'
import { requireFounderHubAccess } from '@/lib/auth/founder-hub'
import { backendSDK } from '@/lib/backend/sdk'

/** Logout is tied to the verified token's session, never a caller-supplied user ID. */
export const POST = route(revokeFounderHubSessionContract, {
  auth: async ({ request }) => requireFounderHubAccess(request.headers),
  handler: async ({ access, request }) =>
    backendSDK({
      organizationId: '',
      requestId: getRequestId(request.headers),
      principal: {
        kind: 'session',
        userId: access.user.id,
        sessionId: access.sessionId,
        display: access.user.email,
      },
    }).revokeFounderHubSession(),
})
