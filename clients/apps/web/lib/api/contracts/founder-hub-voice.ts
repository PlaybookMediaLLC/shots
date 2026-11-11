import { defineContract, type RouteContract } from '@/lib/api/contract'
import {
  createVoiceNoteContract,
  deleteVoiceNoteContract,
  getVoiceNoteContract,
  getVoiceSettingsContract,
  listVoiceNoteIndexContract,
  listVoiceNotesContract,
  updateVoiceMemberSettingsContract,
  updateVoiceNoteContract,
} from './voice'
import {
  addVoiceTranscriptContract,
  completeVoiceRunContract,
  confirmVoiceCommandContract,
  createVoiceDraftContract,
  createVoiceRunUploadContract,
  deleteVoiceAudioContract,
  getVoiceRunAudioContract,
  redactVoiceTranscriptContract,
} from './voice-actions'

/*
 * The voice API for the Founder Hub phone app, which reaches Shots through
 * its gateway at `/api/founder-hub/voice/<suffix>` with the same methods,
 * query strings, bodies, statuses and responses as `/api/v1/voice/<suffix>`.
 * Each contract is its voice contract at the gateway's path. The member
 * requirement stays on the voice contract, which the route enforces, and like
 * every Founder Hub contract these stay out of the public OpenAPI document.
 * Changing the workspace switches is not served here.
 */
function viaFounderHub<C extends RouteContract>(contract: C) {
  return defineContract<C['output'], C['params'], C['query'], C['headers'], C['body']>({
    ...contract,
    access: undefined,
    docs: undefined,
    name: `founder-hub.${contract.name}`,
    path: contract.path.replace(/^\/api\/v1\/voice\//, '/api/founder-hub/voice/'),
  })
}

/** `GET /api/founder-hub/voice/settings` */
export const founderHubGetVoiceSettingsContract = viaFounderHub(getVoiceSettingsContract)

/** `PUT /api/founder-hub/voice/settings/member` */
export const founderHubUpdateVoiceMemberSettingsContract = viaFounderHub(
  updateVoiceMemberSettingsContract
)

/** `GET /api/founder-hub/voice/notes/index` */
export const founderHubListVoiceNoteIndexContract = viaFounderHub(listVoiceNoteIndexContract)

/** `GET /api/founder-hub/voice/notes` */
export const founderHubListVoiceNotesContract = viaFounderHub(listVoiceNotesContract)

/** `POST /api/founder-hub/voice/notes` */
export const founderHubCreateVoiceNoteContract = viaFounderHub(createVoiceNoteContract)

/** `GET /api/founder-hub/voice/notes/{id}` */
export const founderHubGetVoiceNoteContract = viaFounderHub(getVoiceNoteContract)

/** `PATCH /api/founder-hub/voice/notes/{id}` */
export const founderHubUpdateVoiceNoteContract = viaFounderHub(updateVoiceNoteContract)

/** `DELETE /api/founder-hub/voice/notes/{id}` */
export const founderHubDeleteVoiceNoteContract = viaFounderHub(deleteVoiceNoteContract)

/** `POST /api/founder-hub/voice/notes/{id}/transcripts` */
export const founderHubAddVoiceTranscriptContract = viaFounderHub(addVoiceTranscriptContract)

/** `POST /api/founder-hub/voice/notes/{id}/transcripts/{revisionId}/redact` */
export const founderHubRedactVoiceTranscriptContract = viaFounderHub(redactVoiceTranscriptContract)

/** `POST /api/founder-hub/voice/notes/{id}/runs/{runIndex}/upload` */
export const founderHubCreateVoiceRunUploadContract = viaFounderHub(createVoiceRunUploadContract)

/** `POST /api/founder-hub/voice/notes/{id}/runs/{runIndex}/complete` */
export const founderHubCompleteVoiceRunContract = viaFounderHub(completeVoiceRunContract)

/** `GET /api/founder-hub/voice/notes/{id}/runs/{runIndex}/audio` */
export const founderHubGetVoiceRunAudioContract = viaFounderHub(getVoiceRunAudioContract)

/** `DELETE /api/founder-hub/voice/notes/{id}/audio` */
export const founderHubDeleteVoiceAudioContract = viaFounderHub(deleteVoiceAudioContract)

/** `POST /api/founder-hub/voice/notes/{id}/draft` */
export const founderHubCreateVoiceDraftContract = viaFounderHub(createVoiceDraftContract)

/** `POST /api/founder-hub/voice/notes/{id}/command/confirm` */
export const founderHubConfirmVoiceCommandContract = viaFounderHub(confirmVoiceCommandContract)
