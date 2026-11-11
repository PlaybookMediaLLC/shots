import type { z } from 'zod'
import { confirmVoiceCommandContract } from '@/lib/api/contracts/voice-actions'
import { errorResponse, route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'

/** Confirm a spoken scheduling command; the backend re-runs every check and schedules as the member. */
export const POST = route(confirmVoiceCommandContract, {
  auth: memberAccess(confirmVoiceCommandContract.access),
  handler: async ({ access, body, params }) => {
    // 403, not 404: the phone reads 404 as a note that is gone.
    if (!contentDraftsEnabled()) return errorResponse(403, 'Content drafts are not available.')
    return (await backendSDK(access).confirmVoiceCommand(params.id, body)) as z.input<
      typeof confirmVoiceCommandContract.output
    >
  },
})
