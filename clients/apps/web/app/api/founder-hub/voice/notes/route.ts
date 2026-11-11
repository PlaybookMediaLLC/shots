import {
  founderHubCreateVoiceNoteContract,
  founderHubListVoiceNotesContract,
} from '@/lib/api/contracts/founder-hub-voice'
import { createVoiceNoteContract, listVoiceNotesContract } from '@/lib/api/contracts/voice'
import { route } from '@/lib/api/route'
import { createVoiceNote, listVoiceNotes } from '@/lib/api/voice-handlers'
import { requireFounderHubMemberAccess } from '@/lib/auth/founder-hub'

/** For the Founder Hub gateway: the member's live notes, newest received first. */
export const GET = route(founderHubListVoiceNotesContract, {
  auth: async ({ request }) =>
    requireFounderHubMemberAccess(request.headers, listVoiceNotesContract.access),
  handler: listVoiceNotes,
})

/** For the Founder Hub gateway: create a note once per client note id: 201 when new, 200 when replayed. */
export const POST = route(founderHubCreateVoiceNoteContract, {
  auth: async ({ request }) =>
    requireFounderHubMemberAccess(request.headers, createVoiceNoteContract.access),
  handler: createVoiceNote,
})
