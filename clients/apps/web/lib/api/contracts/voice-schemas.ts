import { z } from 'zod'
import { contentDraftIdSchema } from './content-draft-list'
import { memberDocs, type WorkspaceDocsInput } from './workspace-docs'

/**
 * Voice capture's wire shapes (docs/plans/voice-capture-implementation.md,
 * section 4): the Go structs in `server/internal/product/voice.go` and
 * `voice_commands.go`, field for field, and the request bodies. The contracts
 * are in `voice.ts` and `voice-actions.ts`.
 */

const timestamp = z.iso.datetime({ offset: true })
const clientIdSchema = z.string().min(1).max(128)

/** A Go slice: the backend sends `null` for an empty one, the web sends `[]`. */
function goList<Item extends z.ZodType>(item: Item) {
  // Parsed items are valid input again; the casts only restate that for a generic item.
  return z.codec(z.array(item).nullable(), z.array(item), {
    decode: (items) => (items ?? []) as z.input<Item>[],
    encode: (items) => items as z.output<Item>[],
  })
}

/** The path of one of the member's notes. */
export const voiceNoteParamsSchema = z.object({ id: contentDraftIdSchema })

/** A span of transcript on the note timeline; `approximate` marks a recognizer restart. */
export const voiceSegmentSchema = z.object({
  startMs: z.int().nonnegative(),
  endMs: z.int().nonnegative(),
  text: z.string().max(20_000),
  approximate: z.boolean().optional(),
})

/** Where a transcript revision came from. */
export const voiceTranscriptOriginSchema = z.enum(['on_device', 'remote', 'user_edit'])

/** One insert-only transcript revision. */
export const voiceTranscriptRevisionSchema = z.object({
  id: z.string(),
  clientRevisionId: z.string(),
  parentId: z.string().nullable(),
  origin: voiceTranscriptOriginSchema,
  locale: z.string().nullable(),
  engine: z.string().nullable(),
  text: z.string(),
  segments: goList(voiceSegmentSchema),
  redacted: z.boolean(),
  createdByUserId: z.string(),
  createdAt: timestamp,
})

/** One of {@link voiceTranscriptRevisionSchema}. */
export type VoiceTranscriptRevision = z.output<typeof voiceTranscriptRevisionSchema>

/** One uploaded recording run; only an `available` run plays. */
export const voiceAudioRunSchema = z.object({
  runIndex: z.int().nonnegative(),
  startOffsetMs: z.int().nonnegative(),
  durationMs: z.int().nullable(),
  sampleRateHz: z.int().nullable(),
  contentType: z.string(),
  bytes: z.int(),
  sha256: z.string(),
  status: z.enum(['pending', 'available', 'failed', 'deleted']),
})

/** A connected account a spoken command may post to. */
export const voiceCommandCandidateSchema = z.object({
  channelConnectionId: z.string(),
  platform: z.string(),
  name: z.string(),
})

/** A spoken scheduling command's proposal; it is confirmed on the phone (plan 5.4). */
export const voiceCommandSchema = z.object({
  id: z.string(),
  transcriptRevisionId: z.string(),
  status: z.string(),
  action: z.string(),
  platform: z.string().nullable(),
  text: z.string().nullable(),
  localTime: z.string().nullable(),
  timeZone: z.string(),
  scheduledFor: timestamp.nullable(),
  channelConnectionId: z.string().nullable(),
  candidates: goList(voiceCommandCandidateSchema),
  guessed: goList(z.string()),
  flags: goList(z.string()),
  addedWords: goList(z.string()),
  notice: z.string().nullable(),
  contentDraftId: z.string().nullable(),
  scheduledPostId: z.string().nullable(),
  failureReason: z.string().nullable(),
  expiresAt: timestamp.nullable(),
})

/** The sync and inbox view of a note. `recordedAt` is the phone's claim, `receivedAt` the server's. */
export const voiceNoteSchema = z.object({
  id: z.string(),
  clientNoteId: z.string(),
  title: z.string(),
  projectId: z.string().nullable(),
  recordedAt: timestamp,
  recordedTimeZone: z.string(),
  receivedAt: timestamp,
  locale: z.string().nullable(),
  durationMs: z.int().nullable(),
  audioUploadConsent: z.boolean(),
  revision: z.int(),
  deleted: z.boolean(),
  deletedAt: timestamp.nullable(),
  currentTranscriptRevisionId: z.string().nullable(),
  /** Two revisions share a parent and neither was chosen since. */
  transcriptConflict: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
})

/** A note with its transcript revisions, audio runs and command proposal. */
export const voiceNoteDetailSchema = voiceNoteSchema.extend({
  transcripts: goList(voiceTranscriptRevisionSchema),
  runs: goList(voiceAudioRunSchema),
  command: voiceCommandSchema.nullable(),
})

/** Every note of the member's, tombstones included, for the phone's list comparison. */
export const voiceNoteIndexSchema = z.object({
  notes: goList(
    z.object({ id: z.string(), clientNoteId: z.string(), revision: z.int(), deleted: z.boolean() })
  ),
})

/** One page of the inbox: live notes, newest received first, each with an excerpt. */
export const voiceNotePageSchema = z.object({
  notes: goList(voiceNoteSchema.extend({ excerpt: z.string() })),
  nextCursor: z.string().nullable(),
})

/** One of {@link voiceNoteDetailSchema}. */
export type VoiceNoteDetail = z.output<typeof voiceNoteDetailSchema>

/** A workspace's voice switches, all off by default. */
export const voiceWorkspaceFlagsSchema = z.object({
  voiceNotes: z.boolean(),
  audioUpload: z.boolean(),
  draftGeneration: z.boolean(),
  voiceCommands: z.boolean(),
})

/** What the voice screens and the phone read: switches, choices, limits and server-side switches. */
export const voiceSettingsSchema = z.object({
  workspace: voiceWorkspaceFlagsSchema,
  member: z.object({
    /** When the member accepted that transcript text is sent to a model provider. */
    remoteTextConsentAt: timestamp.nullable(),
    voiceCommands: z.boolean(),
  }),
  /** The member may change the workspace switches (owner or admin). */
  canManage: z.boolean(),
  minAppVersion: z.string().nullable(),
  limits: z.object({
    maxNoteMs: z.int(),
    warnAtMs: z.int(),
    minNoteMs: z.int(),
    maxTranscriptChars: z.int(),
    maxCommandChars: z.int(),
  }),
  /** True where the feature is available server-side. */
  switches: z.object({
    notes: z.boolean(),
    audioUpload: z.boolean(),
    drafts: z.boolean(),
    parse: z.boolean(),
    confirm: z.boolean(),
  }),
})

/** One of {@link voiceSettingsSchema}. */
export type VoiceSettings = z.output<typeof voiceSettingsSchema>

/** A change to some workspace switches. */
export const voiceWorkspaceFlagsInputSchema = voiceWorkspaceFlagsSchema.partial().strict()

/** A change to the member's choices; voice commands need the consent. */
export const voiceMemberChoicesInputSchema = z.strictObject({
  remoteTextConsent: z.boolean().optional(),
  voiceCommands: z.boolean().optional(),
})

/** A new note from the phone; a replay of its `clientNoteId` returns the stored note. */
export const voiceNoteCreateSchema = z.strictObject({
  clientNoteId: clientIdSchema,
  title: z.string().max(500).optional(),
  projectId: contentDraftIdSchema.nullish(),
  recordedAt: timestamp,
  recordedTimeZone: z.string().min(1).max(64),
  locale: z.string().min(1).max(35).nullish(),
  durationMs: z.int().nonnegative().nullish(),
  audioUploadConsent: z.boolean().optional(),
})

/** A note's labels; the last writer wins. */
export const voiceNotePatchSchema = z.strictObject({
  expectedRevision: z.int().positive(),
  title: z.string().max(500).optional(),
  projectId: contentDraftIdSchema.nullish(),
})

/** A new transcript revision; a replay of its `clientRevisionId` returns the stored one. */
export const voiceTranscriptCreateSchema = z.strictObject({
  clientRevisionId: clientIdSchema,
  parentId: contentDraftIdSchema.nullish(),
  origin: voiceTranscriptOriginSchema,
  locale: z.string().min(1).max(35).nullish(),
  engine: z.string().min(1).max(100).nullish(),
  text: z.string().max(200_000),
  segments: z.array(voiceSegmentSchema.strict()).max(20_000),
})

/** What adding a transcript revision returns, with the proposal it parsed, if any. */
export const voiceTranscriptResultSchema = z.object({
  revision: voiceTranscriptRevisionSchema,
  note: voiceNoteSchema,
  command: voiceCommandSchema.nullable(),
})

/** One run's file, as the phone declares it before upload. */
export const voiceRunUploadInputSchema = z.strictObject({
  contentType: z.string().min(1).max(100),
  bytes: z.int().positive(),
  sha256: z.string().min(1).max(128),
  startOffsetMs: z.int().nonnegative(),
  durationMs: z.int().nonnegative().nullish(),
  sampleRateHz: z.int().positive().nullish(),
})

/** A signed upload URL; its length and checksum are signed in. */
export const voiceRunUploadSchema = z.object({
  url: z.url(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  expiresAt: timestamp,
})

/** A signed read of an available run. */
export const voiceRunAudioSchema = z.object({ url: z.url(), expiresAt: timestamp })

/** What a draft from a note is for. */
export const voiceDraftIntentSchema = z.enum([
  'launch_post',
  'documentation_outline',
  'onboarding_explanation',
  'saved_idea',
])

/** A draft from one transcript revision. */
export const voiceDraftInputSchema = z.strictObject({
  transcriptRevisionId: contentDraftIdSchema,
  intent: voiceDraftIntentSchema,
  assetIds: z.array(contentDraftIdSchema).max(20).optional(),
})

/** The confirmed text and account of a spoken scheduling command. */
export const voiceCommandConfirmSchema = z.strictObject({
  text: z.string().min(1).max(10_000),
  channelConnectionId: contentDraftIdSchema,
  localTime: z.string().min(1).max(64),
  timeZone: z.string().min(1).max(64),
})

/** What confirming a command did. */
export const voiceCommandConfirmationSchema = z.object({
  command: voiceCommandSchema,
  outcome: z.enum(['scheduled', 'pending_approval', 'draft']),
  contentDraftId: z.string().nullable(),
  scheduledPostId: z.string().nullable(),
})

/** What every voice route needs: a signed-in member. A note is private to its owner. */
export const voiceMemberAccess = { permission: 'workspace:read' } as const

/** The failures the voice routes document, in the backend's terms. */
export const voiceErrors = {
  deleted: 'The note is deleted.',
  notFound: 'The note is not one of yours in this workspace.',
} as const

/** OpenAPI docs for a session-only voice operation. */
export function voiceDocs(
  operationId: string,
  description: string,
  responses: WorkspaceDocsInput['responses']
) {
  return memberDocs({ description, operationId, responses, tag: 'Workspace' })
}
