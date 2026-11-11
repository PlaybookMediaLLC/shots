import type { z } from 'zod'
import { createVoiceDraftContract } from '@/lib/api/contracts/voice-actions'
import { errorResponse, route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'

/** Make a content draft from one transcript revision; the backend checks consent and quota. */
export const POST = route(createVoiceDraftContract, {
  auth: memberAccess(createVoiceDraftContract.access),
  handler: async ({ access, body, params }) => {
    // 403, not 404: the phone reads 404 as a note that is gone.
    if (!contentDraftsEnabled()) return errorResponse(403, 'Content drafts are not available.')
    return (await backendSDK(access).createVoiceDraft(params.id, body)) as z.input<
      typeof createVoiceDraftContract.output
    >
  },
})
