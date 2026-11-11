import { founderHubRedactVoiceTranscriptContract } from '@/lib/api/contracts/founder-hub-voice'
import { redactVoiceTranscriptContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { redactVoiceTranscript } from '@/lib/api/voice-handlers'
import { requireFounderHubMemberAccess } from '@/lib/auth/founder-hub'

/** For the Founder Hub gateway: clear a revision's text and segments; the backend audits it. */
export const POST = route(founderHubRedactVoiceTranscriptContract, {
  auth: async ({ request }) =>
    requireFounderHubMemberAccess(request.headers, redactVoiceTranscriptContract.access),
  handler: redactVoiceTranscript,
})
