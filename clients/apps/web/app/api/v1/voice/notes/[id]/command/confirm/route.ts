import { confirmVoiceCommandContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { confirmVoiceCommand } from '@/lib/api/voice-handlers'

/** Confirm a spoken scheduling command; the backend re-runs every check and schedules as the member. */
export const POST = route(confirmVoiceCommandContract, {
  auth: memberAccess(confirmVoiceCommandContract.access),
  handler: confirmVoiceCommand,
})
