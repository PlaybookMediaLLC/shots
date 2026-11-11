import { founderHubCreateVoiceRunUploadContract } from '@/lib/api/contracts/founder-hub-voice'
import { createVoiceRunUploadContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { createVoiceRunUpload } from '@/lib/api/voice-handlers'
import { requireFounderHubMemberAccess } from '@/lib/auth/founder-hub'

/** For the Founder Hub gateway: a signed upload URL for one run, with its length and checksum signed in. */
export const POST = route(founderHubCreateVoiceRunUploadContract, {
  auth: async ({ request }) =>
    requireFounderHubMemberAccess(request.headers, createVoiceRunUploadContract.access),
  handler: createVoiceRunUpload,
})
