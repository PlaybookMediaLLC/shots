import { getContentBatchRunContract } from '@/lib/api/contracts/content-batch-runs'
import { errorResponse, route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'
import { getContentBatchRun } from '@/lib/tenant/content-batches'

/** What a schedule or render of a batch did. */
export const GET = route(getContentBatchRunContract, {
  auth: memberAccess({ permission: 'artifact:read', feature: 'content:drafts' }),
  handler: async ({ access, params }) => {
    if (!contentDraftsEnabled()) return errorResponse(404, 'Content drafts are not available.')
    return (
      (await getContentBatchRun(access, params.id, params.runId)) ??
      errorResponse(404, 'Run not found.')
    )
  },
})
