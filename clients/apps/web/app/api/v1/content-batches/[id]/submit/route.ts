import { submitContentBatchContract } from '@/lib/api/contracts/content-batch-runs'
import { errorResponse, route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'
import { submitContentBatch } from '@/lib/tenant/content-batches'

/** Schedule items in the background; the same request key replays its run. */
export const POST = route(submitContentBatchContract, {
  auth: memberAccess({ permission: 'publish:manage', feature: 'content:drafts' }),
  handler: async ({ access, body, params }) => {
    if (!contentDraftsEnabled()) return errorResponse(404, 'Content drafts are not available.')
    return (
      (await submitContentBatch(access, params.id, body)) ?? errorResponse(404, 'Batch not found.')
    )
  },
})
