import { founderHubDeleteVoiceAudioContract } from '@/lib/api/contracts/founder-hub-voice'
import { deleteVoiceAudioContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { deleteVoiceAudio } from '@/lib/api/voice-handlers'
import { requireFounderHubMemberAccess } from '@/lib/auth/founder-hub'

/** For the Founder Hub gateway: delete every run's file of a note; its transcripts stay. */
export const DELETE = route(founderHubDeleteVoiceAudioContract, {
  auth: async ({ request }) =>
    requireFounderHubMemberAccess(request.headers, deleteVoiceAudioContract.access),
  handler: deleteVoiceAudio,
})
