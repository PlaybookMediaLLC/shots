import { listVoiceNoteIndexContract } from '@/lib/api/contracts/voice'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { listVoiceNoteIndex } from '@/lib/api/voice-handlers'

/** Every note of the member's with its revision, tombstones included, for sync. */
export const GET = route(listVoiceNoteIndexContract, {
  auth: memberAccess(listVoiceNoteIndexContract.access),
  handler: listVoiceNoteIndex,
})
