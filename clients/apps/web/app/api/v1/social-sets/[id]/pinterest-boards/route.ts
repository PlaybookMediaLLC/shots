import { listPinterestBoardsContract } from '@/lib/api/contracts/social-communities'
import { errorResponse, route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'
import { listSocialSetPinterestBoards } from '@/lib/tenant/write'

/** List a Pinterest account's boards with its own permissions. */
export const GET = route(listPinterestBoardsContract, {
  auth: memberAccess(listPinterestBoardsContract.access),
  handler: async ({ access, params }) => {
    if (!contentDraftsEnabled()) return errorResponse(404, 'Social set not found.')
    const items = await listSocialSetPinterestBoards(access, params.id)
    return items ? { items } : errorResponse(404, 'Social set not found.')
  },
})
