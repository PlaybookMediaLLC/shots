import { founderHubCompleteVoiceRunContract } from '@/lib/api/contracts/founder-hub-voice'
import { completeVoiceRunContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { completeVoiceRun } from '@/lib/api/voice-handlers'
import { requireFounderHubMemberAccess } from '@/lib/auth/founder-hub'

/** For the Founder Hub gateway: check an uploaded run's bytes before it becomes available; a bad file answers 400. */
export const POST = route(founderHubCompleteVoiceRunContract, {
  auth: async ({ request }) =>
    requireFounderHubMemberAccess(request.headers, completeVoiceRunContract.access),
  handler: completeVoiceRun,
})
