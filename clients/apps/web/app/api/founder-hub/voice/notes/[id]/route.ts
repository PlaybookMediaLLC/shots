import {
  founderHubDeleteVoiceNoteContract,
  founderHubGetVoiceNoteContract,
  founderHubUpdateVoiceNoteContract,
} from '@/lib/api/contracts/founder-hub-voice'
import {
  deleteVoiceNoteContract,
  getVoiceNoteContract,
  updateVoiceNoteContract,
} from '@/lib/api/contracts/voice'
import { route } from '@/lib/api/route'
import { deleteVoiceNote, getVoiceNote, updateVoiceNote } from '@/lib/api/voice-handlers'
import { requireFounderHubMemberAccess } from '@/lib/auth/founder-hub'

/** For the Founder Hub gateway: one of the member's notes; another member's is not found. */
export const GET = route(founderHubGetVoiceNoteContract, {
  auth: async ({ request }) =>
    requireFounderHubMemberAccess(request.headers, getVoiceNoteContract.access),
  handler: getVoiceNote,
})

/** For the Founder Hub gateway: change a note's title or project; the last writer wins. */
export const PATCH = route(founderHubUpdateVoiceNoteContract, {
  auth: async ({ request }) =>
    requireFounderHubMemberAccess(request.headers, updateVoiceNoteContract.access),
  handler: updateVoiceNote,
})

/** For the Founder Hub gateway: delete a note; its tombstone stays so an offline phone never recreates it. */
export const DELETE = route(founderHubDeleteVoiceNoteContract, {
  auth: async ({ request }) =>
    requireFounderHubMemberAccess(request.headers, deleteVoiceNoteContract.access),
  handler: deleteVoiceNote,
})
