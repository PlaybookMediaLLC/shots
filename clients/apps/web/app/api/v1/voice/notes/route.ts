import { z } from 'zod'
import { createVoiceNoteContract, listVoiceNotesContract } from '@/lib/api/contracts/voice'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** The member's live notes, newest received first. */
export const GET = route(listVoiceNotesContract, {
  auth: memberAccess(listVoiceNotesContract.access),
  handler: async ({ access, query }) =>
    (await backendSDK(access).listVoiceNotes(query)) as z.input<
      typeof listVoiceNotesContract.output
    >,
})

/** Create a note once per client note id: 201 when new, 200 when replayed. */
export const POST = route(createVoiceNoteContract, {
  auth: memberAccess(createVoiceNoteContract.access),
  handler: async ({ access, body }) => {
    const { body: note, created } = await backendSDK(access).createVoiceNote(body)
    const parsed = createVoiceNoteContract.output.safeParse(note)
    // A backend answer the contract does not describe is a server fault, not a bad request.
    if (!parsed.success)
      throw new Error(
        `The backend answered an unexpected voice note: ${z.prettifyError(parsed.error)}`
      )
    return Response.json(parsed.data, { status: created ? 201 : 200 })
  },
})
