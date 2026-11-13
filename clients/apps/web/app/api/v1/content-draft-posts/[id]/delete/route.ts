import { deleteDraftPostContract } from '@/lib/api/contracts/write'
import { errorResponse, route } from '@/lib/api/route'
import { tenantAccess } from '@/lib/api/route-auth'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'
import { deleteContentDraftPost } from '@/lib/tenant/content-drafts'

const notFound = () => errorResponse(404, 'Post not found.')

/** Start deleting a published post from its platform, with receipts for each part. */
export const POST = route(deleteDraftPostContract, {
  auth: tenantAccess(deleteDraftPostContract.access),
  handler: async ({ access, params }) => {
    if (!contentDraftsEnabled()) return notFound()
    const deletion = await deleteContentDraftPost(access, params.id)
    return deletion ? { deletion } : notFound()
  },
})
