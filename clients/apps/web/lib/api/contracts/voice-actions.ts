import { z } from 'zod'
import { defineContract } from '@/lib/api/contract'
import { contentDraftIdSchema } from './content-draft-list'
import {
  voiceAudioRunSchema,
  voiceCommandConfirmSchema,
  voiceCommandConfirmationSchema,
  voiceDocs,
  voiceDraftInputSchema,
  voiceErrors,
  voiceMemberAccess,
  voiceNoteParamsSchema,
  voiceRunAudioSchema,
  voiceRunUploadInputSchema,
  voiceRunUploadSchema,
  voiceTranscriptCreateSchema,
  voiceTranscriptResultSchema,
  voiceTranscriptRevisionSchema,
} from './voice-schemas'

/**
 * Voice capture's transcript, audio, draft and command contracts
 * (docs/plans/voice-capture-implementation.md, section 4, rows 10-17). Every
 * route is session-only, like those in `voice.ts`.
 */

const voiceRevisionParams = voiceNoteParamsSchema.extend({ revisionId: contentDraftIdSchema })
const voiceRunParams = voiceNoteParamsSchema.extend({
  runIndex: z.coerce.number().int().nonnegative(),
})

/** `POST /api/v1/voice/notes/{id}/transcripts`: 201 for a new revision, 200 for a replay. */
export const addVoiceTranscriptContract = defineContract({
  access: voiceMemberAccess,
  body: voiceTranscriptCreateSchema,
  method: 'POST',
  name: 'voice.transcripts.create',
  output: voiceTranscriptResultSchema,
  params: voiceNoteParamsSchema,
  path: '/api/v1/voice/notes/{id}/transcripts',
  summary: 'Add a transcript revision',
  docs: {
    ...voiceDocs(
      'addVoiceTranscript',
      'Adds an insert-only revision once per client revision id; a user edit becomes current.',
      {
        '200': 'The revision.',
        '201': 'The new revision.',
        '400': 'The revision is invalid.',
        '404': voiceErrors.notFound,
        '409': voiceErrors.deleted,
      }
    ),
    outputName: 'VoiceTranscriptResult',
  },
})

/** `POST /api/v1/voice/notes/{id}/transcripts/{revisionId}/redact` */
export const redactVoiceTranscriptContract = defineContract({
  access: voiceMemberAccess,
  method: 'POST',
  name: 'voice.transcripts.redact',
  output: voiceTranscriptRevisionSchema,
  params: voiceRevisionParams,
  path: '/api/v1/voice/notes/{id}/transcripts/{revisionId}/redact',
  summary: 'Redact a transcript revision',
  docs: voiceDocs(
    'redactVoiceTranscript',
    "Clears a revision's text and segments, and audits it.",
    {
      '200': 'The redacted revision.',
      '404': voiceErrors.notFound,
    }
  ),
})

/** `POST /api/v1/voice/notes/{id}/runs/{runIndex}/upload` */
export const createVoiceRunUploadContract = defineContract({
  access: voiceMemberAccess,
  body: voiceRunUploadInputSchema,
  method: 'POST',
  name: 'voice.runs.upload',
  output: voiceRunUploadSchema,
  params: voiceRunParams,
  path: '/api/v1/voice/notes/{id}/runs/{runIndex}/upload',
  summary: 'Sign an audio run upload',
  docs: voiceDocs(
    'createVoiceRunUpload',
    "A signed URL for one run's file, with its length and checksum signed in.",
    {
      '200': 'The upload URL.',
      '400': 'The run is invalid.',
      '404': voiceErrors.notFound,
      '409': 'The note is deleted, or the run was uploaded with another checksum.',
    }
  ),
})

/** `POST /api/v1/voice/notes/{id}/runs/{runIndex}/complete` */
export const completeVoiceRunContract = defineContract({
  access: voiceMemberAccess,
  method: 'POST',
  name: 'voice.runs.complete',
  output: voiceAudioRunSchema,
  params: voiceRunParams,
  path: '/api/v1/voice/notes/{id}/runs/{runIndex}/complete',
  summary: 'Check an uploaded audio run',
  docs: voiceDocs(
    'completeVoiceRun',
    "Checks the stored file's size, checksum and audio before the run becomes available.",
    {
      '200': 'The run.',
      '400': 'The file is missing or is not the declared audio; upload it again.',
      '404': voiceErrors.notFound,
    }
  ),
})

/** `GET /api/v1/voice/notes/{id}/runs/{runIndex}/audio` */
export const getVoiceRunAudioContract = defineContract({
  access: voiceMemberAccess,
  method: 'GET',
  name: 'voice.runs.audio',
  output: voiceRunAudioSchema,
  params: voiceRunParams,
  path: '/api/v1/voice/notes/{id}/runs/{runIndex}/audio',
  summary: 'Sign an audio run read',
  docs: voiceDocs('getVoiceRunAudio', 'A short-lived signed URL to play an available run.', {
    '200': 'The audio URL.',
    '404': voiceErrors.notFound,
  }),
})

/** `DELETE /api/v1/voice/notes/{id}/audio` */
export const deleteVoiceAudioContract = defineContract({
  access: voiceMemberAccess,
  method: 'DELETE',
  name: 'voice.audio.delete',
  output: z.undefined(),
  params: voiceNoteParamsSchema,
  path: '/api/v1/voice/notes/{id}/audio',
  status: 204,
  summary: "Delete a note's audio",
  docs: voiceDocs('deleteVoiceAudio', "Deletes every run's file; the transcripts stay.", {
    '204': 'Deleted.',
    '404': voiceErrors.notFound,
  }),
})

/** `POST /api/v1/voice/notes/{id}/draft` */
export const createVoiceDraftContract = defineContract({
  access: { feature: 'content:drafts', permission: 'artifact:edit' },
  body: voiceDraftInputSchema,
  method: 'POST',
  name: 'voice.drafts.create',
  output: z.object({ contentDraftId: z.string() }),
  params: voiceNoteParamsSchema,
  path: '/api/v1/voice/notes/{id}/draft',
  summary: 'Make a draft from a voice note',
  docs: voiceDocs(
    'createVoiceDraft',
    "Sends one transcript revision to the model provider, with the member's consent, and saves a draft.",
    {
      '200': 'The draft.',
      '400': 'The request is invalid.',
      '404': voiceErrors.notFound,
    }
  ),
})

/** `POST /api/v1/voice/notes/{id}/command/confirm` */
export const confirmVoiceCommandContract = defineContract({
  access: { feature: 'content:drafts', permission: 'artifact:edit' },
  body: voiceCommandConfirmSchema,
  method: 'POST',
  name: 'voice.command.confirm',
  output: voiceCommandConfirmationSchema,
  params: voiceNoteParamsSchema,
  path: '/api/v1/voice/notes/{id}/command/confirm',
  summary: 'Confirm a spoken scheduling command',
  docs: voiceDocs(
    'confirmVoiceCommand',
    'Re-runs every check, then schedules the confirmed text as the member; a replay returns the outcome.',
    {
      '200': 'What the confirmation did.',
      '400': 'The confirmation is invalid.',
      '404': voiceErrors.notFound,
      '409': 'The proposal can no longer be confirmed.',
    }
  ),
})
