import { getVoiceSettingsContract } from '@/lib/api/contracts/voice'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { getVoiceSettings } from '@/lib/api/voice-handlers'

/** The workspace's voice switches and the member's choices; route() validates the answer. */
export const GET = route(getVoiceSettingsContract, {
  auth: memberAccess(getVoiceSettingsContract.access),
  handler: getVoiceSettings,
})
