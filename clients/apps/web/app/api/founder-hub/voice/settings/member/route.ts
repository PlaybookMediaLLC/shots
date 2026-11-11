import { founderHubUpdateVoiceMemberSettingsContract } from '@/lib/api/contracts/founder-hub-voice'
import { updateVoiceMemberSettingsContract } from '@/lib/api/contracts/voice'
import { route } from '@/lib/api/route'
import { updateVoiceMemberSettings } from '@/lib/api/voice-handlers'
import { requireFounderHubMemberAccess } from '@/lib/auth/founder-hub'

/** For the Founder Hub gateway: record the member's consent and voice command choice; commands need the consent. */
export const PUT = route(founderHubUpdateVoiceMemberSettingsContract, {
  auth: async ({ request }) =>
    requireFounderHubMemberAccess(request.headers, updateVoiceMemberSettingsContract.access),
  handler: updateVoiceMemberSettings,
})
