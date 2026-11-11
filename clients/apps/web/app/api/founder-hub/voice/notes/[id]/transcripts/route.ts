import { founderHubAddVoiceTranscriptContract } from '@/lib/api/contracts/founder-hub-voice'
import { addVoiceTranscriptContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { addVoiceTranscript } from '@/lib/api/voice-handlers'
import { requireFounderHubMemberAccess } from '@/lib/auth/founder-hub'

/** For the Founder Hub gateway: add a revision once per client revision id: 201 when new, 200 when replayed. */
export const POST = route(founderHubAddVoiceTranscriptContract, {
  auth: async ({ request }) =>
    requireFounderHubMemberAccess(request.headers, addVoiceTranscriptContract.access),
  handler: addVoiceTranscript,
})
