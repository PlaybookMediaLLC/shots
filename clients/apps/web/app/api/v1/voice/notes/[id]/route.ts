import {
  deleteVoiceNoteContract,
  getVoiceNoteContract,
  updateVoiceNoteContract,
} from '@/lib/api/contracts/voice'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { deleteVoiceNote, getVoiceNote, updateVoiceNote } from '@/lib/api/voice-handlers'

/** One of the member's notes; another member's is not found. */
export const GET = route(getVoiceNoteContract, {
  auth: memberAccess(getVoiceNoteContract.access),
  handler: getVoiceNote,
})

/** Change a note's title or project; the last writer wins. */
export const PATCH = route(updateVoiceNoteContract, {
  auth: memberAccess(updateVoiceNoteContract.access),
  handler: updateVoiceNote,
})

/** Delete a note; its tombstone stays so an offline phone never recreates it. */
export const DELETE = route(deleteVoiceNoteContract, {
  auth: memberAccess(deleteVoiceNoteContract.access),
  handler: deleteVoiceNote,
})
