import { createVoiceDraftContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { createVoiceDraft } from '@/lib/api/voice-handlers'

/** Make a content draft from one transcript revision; the backend checks consent and quota. */
export const POST = route(createVoiceDraftContract, {
  auth: memberAccess(createVoiceDraftContract.access),
  handler: createVoiceDraft,
})
