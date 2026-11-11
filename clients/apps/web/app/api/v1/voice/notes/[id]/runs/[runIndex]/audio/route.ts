import { getVoiceRunAudioContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { getVoiceRunAudio } from '@/lib/api/voice-handlers'

/** A short-lived signed URL to play one of the member's available runs. */
export const GET = route(getVoiceRunAudioContract, {
  auth: memberAccess(getVoiceRunAudioContract.access),
  handler: getVoiceRunAudio,
})
