import type { z } from 'zod'
import { createVoiceRunUploadContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** A signed upload URL for one run, with its length and checksum signed in. */
export const POST = route(createVoiceRunUploadContract, {
  auth: memberAccess(createVoiceRunUploadContract.access),
  handler: async ({ access, body, params }) =>
    (await backendSDK(access).createVoiceRunUpload(params.id, params.runIndex, body)) as z.input<
      typeof createVoiceRunUploadContract.output
    >,
})
