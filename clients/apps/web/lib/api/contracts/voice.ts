import { z } from 'zod'
import { defineContract } from '@/lib/api/contract'
import {
  voiceDocs,
  voiceNoteIndexSchema,
  voiceNotePageSchema,
  voiceErrors,
  voiceMemberAccess,
  voiceMemberChoicesInputSchema,
  voiceNoteCreateSchema,
  voiceNoteDetailSchema,
  voiceNoteParamsSchema,
  voiceNotePatchSchema,
  voiceSettingsSchema,
  voiceWorkspaceFlagsInputSchema,
} from './voice-schemas'

/**
 * Voice capture's settings, sync and note contracts
 * (docs/plans/voice-capture-implementation.md, section 4, rows 1-9): a
 * member's private recordings at the Go product API's `/v1/voice` paths,
 * served under `/api/v1/voice`. Every route is session-only: an API key has
 * no member, and a note belongs to one.
 */

/** `GET /api/v1/voice/settings` */
export const getVoiceSettingsContract = defineContract({
  access: voiceMemberAccess,
  method: 'GET',
  name: 'voice.settings.get',
  output: voiceSettingsSchema,
  path: '/api/v1/voice/settings',
  summary: 'Read voice settings',
  docs: {
    ...voiceDocs(
      'getVoiceSettings',
      "The workspace's voice switches, the member's choices, limits and server-side switches.",
      { '200': 'The settings.' }
    ),
    outputName: 'VoiceSettings',
  },
})

/** `PUT /api/v1/voice/settings/workspace` */
export const updateVoiceWorkspaceSettingsContract = defineContract({
  access: { permission: 'workspace:update' },
  body: voiceWorkspaceFlagsInputSchema,
  method: 'PUT',
  name: 'voice.settings.workspace',
  output: voiceSettingsSchema,
  path: '/api/v1/voice/settings/workspace',
  summary: 'Change voice workspace switches',
  docs: {
    ...voiceDocs(
      'updateVoiceWorkspaceSettings',
      'Turns voice features on or off for the workspace.',
      {
        '200': 'The settings.',
        '400': 'The switches are invalid.',
      }
    ),
    outputName: 'VoiceSettings',
  },
})

/** `PUT /api/v1/voice/settings/member` */
export const updateVoiceMemberSettingsContract = defineContract({
  access: voiceMemberAccess,
  body: voiceMemberChoicesInputSchema,
  method: 'PUT',
  name: 'voice.settings.member',
  output: voiceSettingsSchema,
  path: '/api/v1/voice/settings/member',
  summary: 'Change your voice choices',
  docs: {
    ...voiceDocs(
      'updateVoiceMemberSettings',
      'Records consent to send transcript text to a model provider, and voice commands, which need it.',
      { '200': 'The settings.', '400': 'The choices are invalid.' }
    ),
    outputName: 'VoiceSettings',
  },
})

/** `GET /api/v1/voice/notes/index` */
export const listVoiceNoteIndexContract = defineContract({
  access: voiceMemberAccess,
  method: 'GET',
  name: 'voice.notes.index',
  output: voiceNoteIndexSchema,
  path: '/api/v1/voice/notes/index',
  summary: 'List your note revisions for sync',
  docs: voiceDocs(
    'listVoiceNoteIndex',
    "Every one of the member's notes in this workspace, deleted ones included, with its revision.",
    { '200': 'The index.' }
  ),
})

/** `GET /api/v1/voice/notes` */
export const listVoiceNotesContract = defineContract({
  access: voiceMemberAccess,
  method: 'GET',
  name: 'voice.notes.list',
  output: voiceNotePageSchema,
  path: '/api/v1/voice/notes',
  query: z.strictObject({
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  }),
  summary: 'List your voice notes',
  docs: voiceDocs('listVoiceNotes', "The member's live notes, newest received first.", {
    '200': 'One page of notes.',
  }),
})

/** `POST /api/v1/voice/notes`: 201 for a new note, 200 for a replay. */
export const createVoiceNoteContract = defineContract({
  access: voiceMemberAccess,
  body: voiceNoteCreateSchema,
  method: 'POST',
  name: 'voice.notes.create',
  output: voiceNoteDetailSchema,
  path: '/api/v1/voice/notes',
  status: 201,
  summary: 'Create a voice note',
  docs: {
    ...voiceDocs(
      'createVoiceNote',
      'Creates a note once per client note id; a replay returns it.',
      {
        '200': 'The note already existed.',
        '201': 'The note.',
        '400': 'The note is invalid.',
        '409': voiceErrors.deleted,
      }
    ),
    outputName: 'VoiceNoteDetail',
  },
})

/** `GET /api/v1/voice/notes/{id}` */
export const getVoiceNoteContract = defineContract({
  access: voiceMemberAccess,
  method: 'GET',
  name: 'voice.notes.get',
  output: voiceNoteDetailSchema,
  params: voiceNoteParamsSchema,
  path: '/api/v1/voice/notes/{id}',
  summary: 'Read a voice note',
  docs: {
    ...voiceDocs('getVoiceNote', 'A note with its transcripts, audio runs and proposal.', {
      '200': 'The note.',
      '404': voiceErrors.notFound,
    }),
    outputName: 'VoiceNoteDetail',
  },
})

/** `PATCH /api/v1/voice/notes/{id}` */
export const updateVoiceNoteContract = defineContract({
  access: voiceMemberAccess,
  body: voiceNotePatchSchema,
  method: 'PATCH',
  name: 'voice.notes.update',
  output: voiceNoteDetailSchema,
  params: voiceNoteParamsSchema,
  path: '/api/v1/voice/notes/{id}',
  summary: 'Rename a voice note',
  docs: {
    ...voiceDocs('updateVoiceNote', "Changes a note's title or project; the last writer wins.", {
      '200': 'The note.',
      '400': 'The change is invalid.',
      '404': voiceErrors.notFound,
      '409': voiceErrors.deleted,
    }),
    outputName: 'VoiceNoteDetail',
  },
})

/** `DELETE /api/v1/voice/notes/{id}` */
export const deleteVoiceNoteContract = defineContract({
  access: voiceMemberAccess,
  method: 'DELETE',
  name: 'voice.notes.delete',
  output: z.undefined(),
  params: voiceNoteParamsSchema,
  path: '/api/v1/voice/notes/{id}',
  status: 204,
  summary: 'Delete a voice note',
  docs: voiceDocs(
    'deleteVoiceNote',
    'Deletes the audio, redacts the transcripts and keeps a tombstone; a replay succeeds.',
    { '204': 'Deleted.', '404': voiceErrors.notFound }
  ),
})
