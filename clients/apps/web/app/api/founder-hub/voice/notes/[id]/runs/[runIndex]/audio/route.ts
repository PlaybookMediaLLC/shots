import { founderHubGetVoiceRunAudioContract } from '@/lib/api/contracts/founder-hub-voice'
import { getVoiceRunAudioContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { getVoiceRunAudio } from '@/lib/api/voice-handlers'
import { requireFounderHubMemberAccess } from '@/lib/auth/founder-hub'

/** For the Founder Hub gateway: a short-lived signed URL to play one of the member's available runs. */
export const GET = route(founderHubGetVoiceRunAudioContract, {
  auth: async ({ request }) =>
    requireFounderHubMemberAccess(request.headers, getVoiceRunAudioContract.access),
  handler: getVoiceRunAudio,
})
