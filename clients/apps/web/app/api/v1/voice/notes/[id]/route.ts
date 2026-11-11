import type { z } from 'zod'
import {
  deleteVoiceNoteContract,
  getVoiceNoteContract,
  updateVoiceNoteContract,
} from '@/lib/api/contracts/voice'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** One of the member's notes; another member's is not found. */
export const GET = route(getVoiceNoteContract, {
  auth: memberAccess(getVoiceNoteContract.access),
  handler: async ({ access, params }) =>
    (await backendSDK(access).getVoiceNote(params.id)) as z.input<
      typeof getVoiceNoteContract.output
    >,
})

/** Change a note's title or project; the last writer wins. */
export const PATCH = route(updateVoiceNoteContract, {
  auth: memberAccess(updateVoiceNoteContract.access),
  handler: async ({ access, body, params }) =>
    (await backendSDK(access).updateVoiceNote(params.id, body)) as z.input<
      typeof updateVoiceNoteContract.output
    >,
})

/** Delete a note; its tombstone stays so an offline phone never recreates it. */
export const DELETE = route(deleteVoiceNoteContract, {
  auth: memberAccess(deleteVoiceNoteContract.access),
  handler: async ({ access, params }) => {
    await backendSDK(access).deleteVoiceNote(params.id)
    return undefined
  },
})
