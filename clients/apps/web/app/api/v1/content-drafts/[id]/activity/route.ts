import { contentDraftActivityContract } from '@/lib/api/contracts/write'
import { errorResponse, route } from '@/lib/api/route'
import { tenantAccess } from '@/lib/api/route-auth'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'
import { listContentDraftActivity } from '@/lib/tenant/write'

const notFound = () => errorResponse(404, 'Content draft not found.')

/** A page of a draft's history, newest first. Viewing is never recorded. */
export const GET = route(contentDraftActivityContract, {
  auth: tenantAccess(contentDraftActivityContract.access),
  handler: async ({ access, params, query }) => {
    if (!contentDraftsEnabled()) return notFound()
    const page = await listContentDraftActivity(access, params.id, query.cursor)
    return page ?? notFound()
  },
})
