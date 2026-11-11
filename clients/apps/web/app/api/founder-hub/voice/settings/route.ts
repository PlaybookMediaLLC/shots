import { founderHubGetVoiceSettingsContract } from '@/lib/api/contracts/founder-hub-voice'
import { getVoiceSettingsContract } from '@/lib/api/contracts/voice'
import { route } from '@/lib/api/route'
import { getVoiceSettings } from '@/lib/api/voice-handlers'
import { requireFounderHubMemberAccess } from '@/lib/auth/founder-hub'

/** For the Founder Hub gateway: the workspace's voice switches and the member's choices; route() validates the answer. */
export const GET = route(founderHubGetVoiceSettingsContract, {
  auth: async ({ request }) =>
    requireFounderHubMemberAccess(request.headers, getVoiceSettingsContract.access),
  handler: getVoiceSettings,
})
