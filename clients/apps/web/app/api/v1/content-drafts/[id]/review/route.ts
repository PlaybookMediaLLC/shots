import { reviewContentDraftContract } from '@/lib/api/contracts/content-draft-platform'
import { errorResponse, route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'
import { accessAllows } from '@/lib/auth/permissions'
import { reviewContentDraft } from '@/lib/tenant/content-drafts'

/** Writers request review; a separate approval permission decides the result. */
export const POST = route(reviewContentDraftContract, {
  auth: memberAccess({ permission: 'artifact:read', feature: 'content:drafts' }),
  handler: async ({ access, body, params }) => {
    if (!contentDraftsEnabled()) return errorResponse(404, 'Content draft not found.')
    const permission = body.action === 'request' ? 'artifact:edit' : 'release:approve'
    if (!accessAllows(access, permission)) {
      return errorResponse(403, 'Your role cannot perform this review action.')
    }
    return (
      (await reviewContentDraft(access, params.id, body)) ??
      errorResponse(404, 'Content draft not found.')
    )
  },
})
