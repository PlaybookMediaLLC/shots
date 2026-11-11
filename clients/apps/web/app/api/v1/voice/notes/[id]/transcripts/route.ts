import { addVoiceTranscriptContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { addVoiceTranscript } from '@/lib/api/voice-handlers'

/** Add a revision once per client revision id: 201 when new, 200 when replayed. */
export const POST = route(addVoiceTranscriptContract, {
  auth: memberAccess(addVoiceTranscriptContract.access),
  handler: addVoiceTranscript,
})
