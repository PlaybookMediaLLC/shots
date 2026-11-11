import { founderHubListVoiceNoteIndexContract } from '@/lib/api/contracts/founder-hub-voice'
import { listVoiceNoteIndexContract } from '@/lib/api/contracts/voice'
import { route } from '@/lib/api/route'
import { listVoiceNoteIndex } from '@/lib/api/voice-handlers'
import { requireFounderHubMemberAccess } from '@/lib/auth/founder-hub'

/** For the Founder Hub gateway: every note of the member's with its revision, tombstones included, for sync. */
export const GET = route(founderHubListVoiceNoteIndexContract, {
  auth: async ({ request }) =>
    requireFounderHubMemberAccess(request.headers, listVoiceNoteIndexContract.access),
  handler: listVoiceNoteIndex,
})
