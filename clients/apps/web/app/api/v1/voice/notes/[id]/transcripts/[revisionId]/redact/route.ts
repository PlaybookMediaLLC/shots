import { redactVoiceTranscriptContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { redactVoiceTranscript } from '@/lib/api/voice-handlers'

/** Clear a revision's text and segments; the backend audits it. */
export const POST = route(redactVoiceTranscriptContract, {
  auth: memberAccess(redactVoiceTranscriptContract.access),
  handler: redactVoiceTranscript,
})
