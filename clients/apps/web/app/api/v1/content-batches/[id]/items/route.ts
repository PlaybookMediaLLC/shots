import {
  addContentBatchItemsContract,
  updateContentBatchItemsContract,
} from '@/lib/api/contracts/content-batches'
import { errorResponse, route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { addContentBatchItems, updateContentBatchItems } from '@/lib/tenant/content-batches'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'

/** Stage items; a retried import key returns its item, other content under it is a 409. */
export const POST = route(addContentBatchItemsContract, {
  auth: memberAccess({ permission: 'artifact:edit', feature: 'content:drafts' }),
  handler: async ({ access, body, params }) => {
    if (!contentDraftsEnabled()) return errorResponse(404, 'Content drafts are not available.')
    return addContentBatchItems(access, params.id, body.items)
  },
})

/** Change many items as one operation: a refused item refuses them all. */
export const PATCH = route(updateContentBatchItemsContract, {
  auth: memberAccess({ permission: 'artifact:edit', feature: 'content:drafts' }),
  handler: async ({ access, body, params }) => {
    if (!contentDraftsEnabled()) return errorResponse(404, 'Content drafts are not available.')
    return updateContentBatchItems(access, params.id, body.items)
  },
})
