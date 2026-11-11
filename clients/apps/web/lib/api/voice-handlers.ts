import 'server-only'

import { z } from 'zod'
import {
  createVoiceNoteContract,
  deleteVoiceNoteContract,
  getVoiceNoteContract,
  getVoiceSettingsContract,
  listVoiceNoteIndexContract,
  listVoiceNotesContract,
  updateVoiceMemberSettingsContract,
  updateVoiceNoteContract,
} from '@/lib/api/contracts/voice'
import {
  addVoiceTranscriptContract,
  completeVoiceRunContract,
  confirmVoiceCommandContract,
  createVoiceDraftContract,
  createVoiceRunUploadContract,
  deleteVoiceAudioContract,
  getVoiceRunAudioContract,
  redactVoiceTranscriptContract,
} from '@/lib/api/contracts/voice-actions'
import { errorResponse, type RouteBinding } from '@/lib/api/route'
import type { OrganizationAccess } from '@/lib/auth/access'
import { backendSDK } from '@/lib/backend/sdk'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'

/*
 * The voice routes' handlers (docs/plans/voice-capture-implementation.md,
 * section 4). The browser's `/api/v1/voice` routes and the Founder Hub
 * gateway's `/api/founder-hub/voice` routes bind the same handler and differ
 * only in how they authenticate the member. Changing the workspace switches
 * stays a browser route, so its handler stays in its route file.
 */

/** The workspace's voice switches and the member's choices; route() validates the answer. */
export const getVoiceSettings: RouteBinding<
  typeof getVoiceSettingsContract,
  OrganizationAccess
>['handler'] = async ({ access }) =>
  (await backendSDK(access).getVoiceSettings()) as z.input<typeof getVoiceSettingsContract.output>

/** Record the member's consent and voice command choice; commands need the consent. */
export const updateVoiceMemberSettings: RouteBinding<
  typeof updateVoiceMemberSettingsContract,
  OrganizationAccess
>['handler'] = async ({ access, body }) =>
  (await backendSDK(access).updateVoiceMemberSettings(body)) as z.input<
    typeof updateVoiceMemberSettingsContract.output
  >

/** Every note of the member's with its revision, tombstones included, for sync. */
export const listVoiceNoteIndex: RouteBinding<
  typeof listVoiceNoteIndexContract,
  OrganizationAccess
>['handler'] = async ({ access }) =>
  (await backendSDK(access).listVoiceNoteIndex()) as z.input<
    typeof listVoiceNoteIndexContract.output
  >

/** The member's live notes, newest received first. */
export const listVoiceNotes: RouteBinding<
  typeof listVoiceNotesContract,
  OrganizationAccess
>['handler'] = async ({ access, query }) =>
  (await backendSDK(access).listVoiceNotes(query)) as z.input<typeof listVoiceNotesContract.output>

/** Create a note once per client note id: 201 when new, 200 when replayed. */
export const createVoiceNote: RouteBinding<
  typeof createVoiceNoteContract,
  OrganizationAccess
>['handler'] = async ({ access, body }) => {
  const { body: note, created } = await backendSDK(access).createVoiceNote(body)
  const parsed = createVoiceNoteContract.output.safeParse(note)
  // A backend answer the contract does not describe is a server fault, not a bad request.
  if (!parsed.success)
    throw new Error(
      `The backend answered an unexpected voice note: ${z.prettifyError(parsed.error)}`
    )
  return Response.json(parsed.data, { status: created ? 201 : 200 })
}

/** One of the member's notes; another member's is not found. */
export const getVoiceNote: RouteBinding<
  typeof getVoiceNoteContract,
  OrganizationAccess
>['handler'] = async ({ access, params }) =>
  (await backendSDK(access).getVoiceNote(params.id)) as z.input<typeof getVoiceNoteContract.output>

/** Change a note's title or project; the last writer wins. */
export const updateVoiceNote: RouteBinding<
  typeof updateVoiceNoteContract,
  OrganizationAccess
>['handler'] = async ({ access, body, params }) =>
  (await backendSDK(access).updateVoiceNote(params.id, body)) as z.input<
    typeof updateVoiceNoteContract.output
  >

/** Delete a note; its tombstone stays so an offline phone never recreates it. */
export const deleteVoiceNote: RouteBinding<
  typeof deleteVoiceNoteContract,
  OrganizationAccess
>['handler'] = async ({ access, params }) => {
  await backendSDK(access).deleteVoiceNote(params.id)
  return undefined
}

/** Add a revision once per client revision id: 201 when new, 200 when replayed. */
export const addVoiceTranscript: RouteBinding<
  typeof addVoiceTranscriptContract,
  OrganizationAccess
>['handler'] = async ({ access, body, params }) => {
  const { body: result, created } = await backendSDK(access).addVoiceTranscript(params.id, body)
  const parsed = addVoiceTranscriptContract.output.safeParse(result)
  // A backend answer the contract does not describe is a server fault, not a bad request.
  if (!parsed.success)
    throw new Error(
      `The backend answered an unexpected transcript: ${z.prettifyError(parsed.error)}`
    )
  return Response.json(parsed.data, { status: created ? 201 : 200 })
}

/** Clear a revision's text and segments; the backend audits it. */
export const redactVoiceTranscript: RouteBinding<
  typeof redactVoiceTranscriptContract,
  OrganizationAccess
>['handler'] = async ({ access, params }) =>
  (await backendSDK(access).redactVoiceTranscript(params.id, params.revisionId)) as z.input<
    typeof redactVoiceTranscriptContract.output
  >

/** A signed upload URL for one run, with its length and checksum signed in. */
export const createVoiceRunUpload: RouteBinding<
  typeof createVoiceRunUploadContract,
  OrganizationAccess
>['handler'] = async ({ access, body, params }) =>
  (await backendSDK(access).createVoiceRunUpload(params.id, params.runIndex, body)) as z.input<
    typeof createVoiceRunUploadContract.output
  >

/** Check an uploaded run's bytes before it becomes available; a bad file answers 400. */
export const completeVoiceRun: RouteBinding<
  typeof completeVoiceRunContract,
  OrganizationAccess
>['handler'] = async ({ access, params }) =>
  (await backendSDK(access).completeVoiceRun(params.id, params.runIndex)) as z.input<
    typeof completeVoiceRunContract.output
  >

/** A short-lived signed URL to play one of the member's available runs. */
export const getVoiceRunAudio: RouteBinding<
  typeof getVoiceRunAudioContract,
  OrganizationAccess
>['handler'] = async ({ access, params }) =>
  (await backendSDK(access).getVoiceRunAudio(params.id, params.runIndex)) as z.input<
    typeof getVoiceRunAudioContract.output
  >

/** Delete every run's file of a note; its transcripts stay. */
export const deleteVoiceAudio: RouteBinding<
  typeof deleteVoiceAudioContract,
  OrganizationAccess
>['handler'] = async ({ access, params }) => {
  await backendSDK(access).deleteVoiceAudio(params.id)
  return undefined
}

/** Make a content draft from one transcript revision; the backend checks consent and quota. */
export const createVoiceDraft: RouteBinding<
  typeof createVoiceDraftContract,
  OrganizationAccess
>['handler'] = async ({ access, body, params }) => {
  // 403, not 404: the phone reads 404 as a note that is gone.
  if (!contentDraftsEnabled()) return errorResponse(403, 'Content drafts are not available.')
  return (await backendSDK(access).createVoiceDraft(params.id, body)) as z.input<
    typeof createVoiceDraftContract.output
  >
}

/** Confirm a spoken scheduling command; the backend re-runs every check and schedules as the member. */
export const confirmVoiceCommand: RouteBinding<
  typeof confirmVoiceCommandContract,
  OrganizationAccess
>['handler'] = async ({ access, body, params }) => {
  // 403, not 404: the phone reads 404 as a note that is gone.
  if (!contentDraftsEnabled()) return errorResponse(403, 'Content drafts are not available.')
  return (await backendSDK(access).confirmVoiceCommand(params.id, body)) as z.input<
    typeof confirmVoiceCommandContract.output
  >
}
