import { getRequestId } from '@/lib/api/request-context'
import { getFounderHubKeySessionContract } from '@/lib/api/contracts/founder-hub'
import { route } from '@/lib/api/route'
import { requireFounderHubService, withFounderHubPermissions } from '@/lib/auth/founder-hub'
import { backendSDK } from '@/lib/backend/sdk'

/** Stored key bindings are accepted only from the trusted Hub service, never from a browser. */
export const POST = route(getFounderHubKeySessionContract, {
  auth: async ({ request }) => requireFounderHubService(request.headers),
  handler: async ({ body, request }) =>
    withFounderHubPermissions(
      await backendSDK({
        organizationId: '',
        requestId: getRequestId(request.headers),
        principal: { kind: 'session', userId: body.userId, sessionId: body.sessionId, display: '' },
      }).getFounderHubKeySession()
    ),
})
