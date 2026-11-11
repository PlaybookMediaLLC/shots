import { deleteVoiceAudioContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Delete every run's file of a note; its transcripts stay. */
export const DELETE = route(deleteVoiceAudioContract, {
  auth: memberAccess(deleteVoiceAudioContract.access),
  handler: async ({ access, params }) => {
    await backendSDK(access).deleteVoiceAudio(params.id)
    return undefined
  },
})
