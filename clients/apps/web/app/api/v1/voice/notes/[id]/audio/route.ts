import { deleteVoiceAudioContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { deleteVoiceAudio } from '@/lib/api/voice-handlers'

/** Delete every run's file of a note; its transcripts stay. */
export const DELETE = route(deleteVoiceAudioContract, {
  auth: memberAccess(deleteVoiceAudioContract.access),
  handler: deleteVoiceAudio,
})
