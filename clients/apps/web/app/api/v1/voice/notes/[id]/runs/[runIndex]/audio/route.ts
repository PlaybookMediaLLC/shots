import type { z } from 'zod'
import { getVoiceRunAudioContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** A short-lived signed URL to play one of the member's available runs. */
export const GET = route(getVoiceRunAudioContract, {
  auth: memberAccess(getVoiceRunAudioContract.access),
  handler: async ({ access, params }) =>
    (await backendSDK(access).getVoiceRunAudio(params.id, params.runIndex)) as z.input<
      typeof getVoiceRunAudioContract.output
    >,
})
