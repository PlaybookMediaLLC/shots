import { completeVoiceRunContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { completeVoiceRun } from '@/lib/api/voice-handlers'

/** Check an uploaded run's bytes before it becomes available; a bad file answers 400. */
export const POST = route(completeVoiceRunContract, {
  auth: memberAccess(completeVoiceRunContract.access),
  handler: completeVoiceRun,
})
