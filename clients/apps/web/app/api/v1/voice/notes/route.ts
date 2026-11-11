import { createVoiceNoteContract, listVoiceNotesContract } from '@/lib/api/contracts/voice'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { createVoiceNote, listVoiceNotes } from '@/lib/api/voice-handlers'

/** The member's live notes, newest received first. */
export const GET = route(listVoiceNotesContract, {
  auth: memberAccess(listVoiceNotesContract.access),
  handler: listVoiceNotes,
})

/** Create a note once per client note id: 201 when new, 200 when replayed. */
export const POST = route(createVoiceNoteContract, {
  auth: memberAccess(createVoiceNoteContract.access),
  handler: createVoiceNote,
})
