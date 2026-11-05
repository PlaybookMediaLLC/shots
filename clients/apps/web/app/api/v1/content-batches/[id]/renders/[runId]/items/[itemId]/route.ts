import { reportContentBatchRenderContract } from '@/lib/api/contracts/content-batch-runs'
import { errorResponse, route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'
import { reportContentBatchRender } from '@/lib/tenant/content-batches'

/** Record a rendered video on its item if its concept is unchanged, or why it failed. */
export const POST = route(reportContentBatchRenderContract, {
  auth: memberAccess({ permission: 'artifact:edit', feature: 'content:drafts' }),
  handler: async ({ access, body, params }) => {
    if (!contentDraftsEnabled()) return errorResponse(404, 'Content drafts are not available.')
    return (
      (await reportContentBatchRender(access, params.id, params.runId, params.itemId, body)) ??
      errorResponse(404, 'Render not found.')
    )
  },
})
