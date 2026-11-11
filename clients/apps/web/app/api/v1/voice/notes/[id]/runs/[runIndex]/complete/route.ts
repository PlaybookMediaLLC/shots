import type { z } from 'zod'
import { completeVoiceRunContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Check an uploaded run's bytes before it becomes available; a bad file answers 400. */
export const POST = route(completeVoiceRunContract, {
  auth: memberAccess(completeVoiceRunContract.access),
  handler: async ({ access, params }) =>
    (await backendSDK(access).completeVoiceRun(params.id, params.runIndex)) as z.input<
      typeof completeVoiceRunContract.output
    >,
})
