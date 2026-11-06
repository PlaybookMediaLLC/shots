import { createPostContract } from '@/lib/api/contracts/posts'
import { errorResponse, route } from '@/lib/api/route'
import { tenantAccess } from '@/lib/api/route-auth'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'
import { createPost } from '@/lib/tenant/content-drafts'

/** Write a post and put it on its accounts. A repeat with the same `Idempotency-Key` replays it. */
export const POST = route(createPostContract, {
  auth: tenantAccess(createPostContract.access),
  handler: async ({ access, body, headers }) => {
    if (!contentDraftsEnabled()) return errorResponse(404, 'Not found.')
    return createPost(access, { ...body, idempotencyKey: headers['idempotency-key'] })
  },
  status: (result) => (result.created ? 201 : 200),
})
