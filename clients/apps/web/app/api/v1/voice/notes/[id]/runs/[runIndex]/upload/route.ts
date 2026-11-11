import { createVoiceRunUploadContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { createVoiceRunUpload } from '@/lib/api/voice-handlers'

/** A signed upload URL for one run, with its length and checksum signed in. */
export const POST = route(createVoiceRunUploadContract, {
  auth: memberAccess(createVoiceRunUploadContract.access),
  handler: createVoiceRunUpload,
})
