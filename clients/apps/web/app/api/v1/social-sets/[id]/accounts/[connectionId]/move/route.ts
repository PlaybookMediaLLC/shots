import { moveSocialSetAccountContract } from '@/lib/api/contracts/social-sets'
import { errorResponse, route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'

/** Move an existing connection without changing its credentials or published history. */
export const POST = route(moveSocialSetAccountContract, {
  auth: organizationAccess('connection:manage'),
  handler: ({ access, params, body }) =>
    contentDraftsEnabled()
      ? backendSDK(access).moveSocialSetAccount(
          params.id,
          params.connectionId,
          body.destinationSocialSetId
        )
      : errorResponse(404, 'Social sets are not available.'),
})
