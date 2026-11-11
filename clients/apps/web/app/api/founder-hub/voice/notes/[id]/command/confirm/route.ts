import { founderHubConfirmVoiceCommandContract } from '@/lib/api/contracts/founder-hub-voice'
import { confirmVoiceCommandContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { confirmVoiceCommand } from '@/lib/api/voice-handlers'
import { requireFounderHubMemberAccess } from '@/lib/auth/founder-hub'

/** For the Founder Hub gateway: confirm a spoken scheduling command; the backend re-runs every check and schedules as the member. */
export const POST = route(founderHubConfirmVoiceCommandContract, {
  auth: async ({ request }) =>
    requireFounderHubMemberAccess(request.headers, confirmVoiceCommandContract.access),
  handler: confirmVoiceCommand,
})
