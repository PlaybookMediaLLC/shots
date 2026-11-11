import { updateVoiceMemberSettingsContract } from '@/lib/api/contracts/voice'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { updateVoiceMemberSettings } from '@/lib/api/voice-handlers'

/** Record the member's consent and voice command choice; commands need the consent. */
export const PUT = route(updateVoiceMemberSettingsContract, {
  auth: memberAccess(updateVoiceMemberSettingsContract.access),
  handler: updateVoiceMemberSettings,
})
