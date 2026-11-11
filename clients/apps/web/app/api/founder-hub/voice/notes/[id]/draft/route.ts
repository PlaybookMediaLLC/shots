import { founderHubCreateVoiceDraftContract } from '@/lib/api/contracts/founder-hub-voice'
import { createVoiceDraftContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { createVoiceDraft } from '@/lib/api/voice-handlers'
import { requireFounderHubMemberAccess } from '@/lib/auth/founder-hub'

/** For the Founder Hub gateway: make a content draft from one transcript revision; the backend checks consent and quota. */
export const POST = route(founderHubCreateVoiceDraftContract, {
  auth: async ({ request }) =>
    requireFounderHubMemberAccess(request.headers, createVoiceDraftContract.access),
  handler: createVoiceDraft,
})
