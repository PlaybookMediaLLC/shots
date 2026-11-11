import type { z } from 'zod'
import { listVoiceNoteIndexContract } from '@/lib/api/contracts/voice'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Every note of the member's with its revision, tombstones included, for sync. */
export const GET = route(listVoiceNoteIndexContract, {
  auth: memberAccess(listVoiceNoteIndexContract.access),
  handler: async ({ access }) =>
    (await backendSDK(access).listVoiceNoteIndex()) as z.input<
      typeof listVoiceNoteIndexContract.output
    >,
})
