import { createContentBatchRenderContract } from '@/lib/api/contracts/content-batch-runs'
import { errorResponse, route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'
import { createContentBatchRender } from '@/lib/tenant/content-batches'

/** Freeze grid concepts for this browser to render; replaces an earlier render of the batch. */
export const POST = route(createContentBatchRenderContract, {
  auth: memberAccess({ permission: 'artifact:edit', feature: 'content:drafts' }),
  handler: async ({ access, body, params }) => {
    if (!contentDraftsEnabled()) return errorResponse(404, 'Content drafts are not available.')
    return (
      (await createContentBatchRender(access, params.id, body)) ??
      errorResponse(404, 'Batch not found.')
    )
  },
})
