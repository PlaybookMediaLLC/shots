import { z } from 'zod'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const text = (limit: number) =>
  z
    .string()
    .min(1)
    .max(limit)
    .refine((value) => value.trim().length > 0 && !value.includes('\0'))
const timestamp = z.iso.datetime({ offset: true })
const releaseSourceBriefSchema = z.strictObject({ title: text(160), benefitStatement: text(500) })

/** Decimal bigint counter; JSON numbers would lose precision. */
export const readinessRevisionSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => value.length < 19 || value <= '9223372036854775807')

/** Required on every new readiness mutation, preserved when retrying it. */
export const readinessCommandKeySchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      value.trim() === value &&
      !['\0', '\r', '\n', '\t'].some((character) => value.includes(character))
  )

/** Human-confirmed rollout; UNKNOWN is an honest incomplete draft. */
export const releaseRolloutSchema = z.enum([
  'UNKNOWN',
  'PLANNED',
  'LIMITED',
  'GENERAL',
  'WITHDRAWN',
])

/** Material kinds required by one audience. */
export const releaseMaterialSchema = z.enum([
  'FACT_SHEET',
  'SALES_NOTES',
  'CS_NOTES',
  'ANNOUNCEMENT',
  'FAQ',
  'SCREENSHOT',
])

/** Audience identity stays stable when its display label changes. */
export const releaseAudienceSchema = z
  .strictObject({
    id,
    kind: z.enum(['SALES', 'CUSTOMER_SUCCESS', 'CUSTOMER', 'OTHER']),
    label: text(160).nullable(),
    materials: z.array(releaseMaterialSchema).max(6),
    omissions: z
      .array(z.strictObject({ material: releaseMaterialSchema, reason: text(4000) }))
      .max(6),
  })
  .refine(
    (audience) => {
      const materials = [
        ...audience.materials,
        ...audience.omissions.map((omission) => omission.material),
      ]
      return new Set(materials).size === materials.length
    },
    { path: ['materials'], message: 'Choose each material once, either required or omitted.' }
  )

/** Facts are proposed until an assigned human reviewer makes a decision. */
export const releaseFactsSchema = z
  .strictObject({
    ownerUserId: id.nullable(),
    factReviewerUserId: id.nullable(),
    rationale: text(4000).nullable(),
    rollout: releaseRolloutSchema,
    availability: text(4000).nullable(),
    exclusions: text(4000).nullable(),
    eligibility: text(4000).nullable(),
    plannedAvailability: text(4000).nullable(),
    readyAt: timestamp.nullable(),
    humanBrief: text(10000).nullable(),
    humanBriefAuthorUserId: id.nullable(),
    sourceUrls: z
      .array(z.url({ protocol: /^https?$/ }).max(2000))
      .max(200)
      .refine((urls) => new Set(urls).size === urls.length, {
        message: 'Use each source link once.',
      }),
    sourceAssetIds: z
      .array(id)
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'Use each source file once.' }),
    requirements: z
      .array(releaseAudienceSchema)
      .max(20)
      .refine(
        (audiences) => new Set(audiences.map((audience) => audience.id)).size === audiences.length,
        { message: 'Use a distinct ID for each audience.' }
      ),
  })
  .refine((facts) => facts.sourceUrls.length + facts.sourceAssetIds.length <= 200, {
    message: 'Use at most 200 sources.',
  })
  .refine((facts) => (facts.humanBrief === null) === (facts.humanBriefAuthorUserId === null), {
    path: ['humanBriefAuthorUserId'],
    message: 'Name the person who supplied the human brief.',
  })
  .refine(
    (facts) => facts.requirements.every((audience) => audience.kind !== 'OTHER' || audience.label),
    { path: ['requirements'], message: 'Give each Other audience a name.' }
  )
  .refine(
    (facts) =>
      facts.requirements.reduce(
        (total, audience) => total + audience.materials.length + audience.omissions.length,
        0
      ) <= 50,
    { message: 'Use at most 50 material requirements and omissions.' }
  )

/** One immutable draft revision, with an optional reason for reopening. */
export const createQualificationSchema = z.strictObject({
  expectedRevision: readinessRevisionSchema,
  facts: releaseFactsSchema,
  reason: text(4000).nullable().optional(),
})

/** Persisted decisions; reopening creates a new unqualified facts revision. */
export const qualificationDecisionSchema = z.enum([
  'QUALIFIED',
  'NO_COMMUNICATION',
  'DEFERRED',
  'WITHDRAWN',
])

/** A decision or reopening by the assigned, currently authorized human reviewer. */
export const decideQualificationSchema = z
  .strictObject({
    expectedRevision: readinessRevisionSchema,
    qualificationRevisionId: id,
    decision: z.enum([...qualificationDecisionSchema.options, 'REOPEN']),
    reason: text(4000),
    revisitAt: timestamp.nullable().optional(),
  })
  .refine((input) => input.revisitAt == null || input.decision === 'DEFERRED', {
    path: ['revisitAt'],
    message: 'A revisit time is only available when deferring a release.',
  })

/** Minimal immutable references returned on creation and receipt replay. */
export const qualificationResultSchema = z.object({
  created: z.boolean(),
  revision: readinessRevisionSchema,
  qualificationRevisionId: id,
  decisionId: id.nullable(),
})

/** A stable repair action without source excerpts or provider errors. */
export const qualificationBlockerSchema = z.object({
  field: z.string(),
  reason: z.enum([
    'OWNER_REQUIRED',
    'REVIEWER_REQUIRED',
    'SOURCE_REQUIRED',
    'AUDIENCE_REQUIRED',
    'MATERIAL_REQUIRED',
    'ROLLOUT_UNKNOWN',
    'ROLLOUT_WITHDRAWN',
    'AVAILABILITY_REQUIRED',
    'EXCLUSIONS_REQUIRED',
    'ELIGIBILITY_REQUIRED',
    'PLANNED_AVAILABILITY_REQUIRED',
    'READY_TIME_REQUIRED',
  ]),
  objectId: id.nullable(),
  ownerUserId: id.nullable(),
  repairAction: z.literal('REVISE_FACTS'),
})

/** Structured conflict or availability details preserved by all transports. */
export const qualificationErrorDetailsSchema = z.object({
  reason: z.enum([
    'MISSING_FACTS',
    'READINESS_DISABLED',
    'COMMAND_KEY_REUSED',
    'CANONICAL_RELEASE_CHANGED',
    'RELEASE_INACTIVE',
    'QUALIFICATION_UNAVAILABLE',
    'REVISION_CONFLICT',
    'SOURCE_CHANGED',
    'SOURCE_SELECTION_CHANGED',
    'RELEASE_ALREADY_QUALIFIED',
    'RELEASE_HAS_REVIEWED_WORK',
    'CLAIM_LIMIT',
    'CLAIM_CHANGED',
    'CONTRADICTION_NOT_REVIEWED',
    'CLAIM_QUALIFIERS_MISSING',
    'EVIDENCE_UNAVAILABLE',
    'AI_EVIDENCE_UNCONFIRMED',
    'ATTESTATION_UNCONFIRMED',
    'SUPPORT_MISSING',
    'EVIDENCE_ALREADY_ATTACHED',
    'QUALIFICATION_REQUIRED',
    'DELETE_SOURCE_ASSET_FIRST',
    'NATIVE_REVISION_CONFLICT',
    'OUTPUT_INCOMPLETE',
    'CLAIM_UNVERIFIED',
  ]),
  currentRevision: readinessRevisionSchema,
  blockers: z.array(qualificationBlockerSchema),
  canonicalReleaseId: id.optional(),
})

/** One immutable provider observation; receipt time never establishes provider order. */
export const releaseSourceObservationSchema = z.object({
  id,
  sequence: readinessRevisionSchema,
  providerEventId: z.string().nullable(),
  sourceUpdatedAt: timestamp.nullable(),
  occurredAt: timestamp,
  receivedAt: timestamp,
  origin: z.enum(['LIVE', 'HISTORICAL']),
  snapshot: z.object({
    title: z.string(),
    notes: z.string(),
    url: z.url({ protocol: /^https?$/ }).nullable(),
    repositoryName: z.string().nullable(),
    commit: z.string().nullable(),
    environment: z.string().nullable(),
    providerState: z.string().nullable(),
  }),
})

/** Durable source identity and the separately selected and current observations. */
export const releaseSourceSchema = z.object({
  id,
  sourceAppId: id,
  sourceName: z.string(),
  provider: z.string(),
  kind: z.enum(['PULL_REQUEST', 'DEPLOYMENT']),
  repositoryId: z.string(),
  providerObjectId: z.string(),
  canonicalReleaseId: id.nullable(),
  sequence: readinessRevisionSchema,
  available: z.boolean(),
  needsResolution: z.boolean(),
  selectionNeedsReview: z.boolean(),
  current: releaseSourceObservationSchema.nullable(),
  selected: releaseSourceObservationSchema.nullable(),
})

/** Source inbox or release-specific page; no mutation silently truncates a selection. */
export const releaseSourcePageSchema = z.object({
  items: z.array(releaseSourceSchema).max(50),
  nextCursor: id.nullable(),
})

/** Bounded observation history includes its owning source and sequence cursor. */
export const releaseSourceHistorySchema = z.object({
  source: releaseSourceSchema,
  items: z.array(releaseSourceObservationSchema).max(50),
  nextCursor: readinessRevisionSchema.nullable(),
})

/** Attach exact observations to one existing release or atomically create its human brief. */
export const selectReleaseSourcesSchema = z
  .strictObject({
    releaseId: id.nullable(),
    newRelease: releaseSourceBriefSchema.nullable(),
    expectedRevision: readinessRevisionSchema,
    sources: z
      .array(
        z.strictObject({
          bindingId: id,
          observationId: id,
          expectedSequence: readinessRevisionSchema.refine((value) => value !== '0'),
        })
      )
      .min(1)
      .max(200),
  })
  .refine((value) => (value.releaseId === null) !== (value.newRelease === null), {
    message: 'Choose an existing release or provide a new release brief.',
  })
  .refine((value) => value.newRelease === null || value.expectedRevision === '0', {
    path: ['expectedRevision'],
    message: 'A new release starts at revision zero.',
  })
  .refine(
    (value) =>
      new Set(value.sources.map((source) => source.bindingId)).size === value.sources.length,
    {
      path: ['sources'],
      message: 'Choose each source object once.',
    }
  )

/** Command receipt; a replay returns the original release and aggregate revision. */
export const releaseSourceSelectionSchema = z.object({
  created: z.boolean(),
  releaseId: id,
  revision: readinessRevisionSchema,
})

const lineageBindingIds = z
  .array(id)
  .max(200)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: 'Choose each source once.',
  })

/** Merge complete source selections into the release named in the path. */
export const mergeReleaseSchema = z.strictObject({
  expectedRevision: readinessRevisionSchema,
  sources: z
    .array(z.strictObject({ releaseId: id, expectedRevision: readinessRevisionSchema }))
    .min(1)
    .max(19)
    .refine(
      (sources) => new Set(sources.map((source) => source.releaseId)).size === sources.length,
      {
        message: 'Choose each release once.',
      }
    ),
  bindingIds: lineageBindingIds,
  reason: text(4000),
})

/** Move disjoint source groups into new, unqualified releases with human briefs. */
export const splitReleaseSchema = z
  .strictObject({
    expectedRevision: readinessRevisionSchema,
    groups: z
      .array(
        z.strictObject({
          bindingIds: lineageBindingIds.refine((ids) => ids.length > 0, {
            message: 'Choose at least one source.',
          }),
          newRelease: releaseSourceBriefSchema,
        })
      )
      .min(1)
      .max(20),
    reason: text(4000),
  })
  .refine(
    (input) => {
      const ids = input.groups.flatMap((group) => group.bindingIds)
      return ids.length <= 200 && new Set(ids).size === ids.length
    },
    { path: ['groups'], message: 'Choose at most 200 sources, each in one group.' }
  )

/** Original result references remain stable across retries and later regrouping. */
export const releaseLineageResultSchema = z.object({
  created: z.boolean(),
  releaseId: id,
  releases: z
    .array(z.object({ releaseId: id, revision: readinessRevisionSchema }))
    .min(2)
    .max(21),
  lineageIds: z.array(id).min(1).max(20),
})

/** Immutable human grouping history; session credentials are never exposed. */
export const releaseLineageEntrySchema = z.object({
  id,
  operation: z.enum(['MERGE', 'SPLIT']),
  sourceReleaseId: id,
  destinationReleaseId: id,
  sourceRevision: readinessRevisionSchema,
  destinationRevision: readinessRevisionSchema,
  reason: z.string(),
  humanUserId: id,
  createdAt: timestamp,
  bindingIds: z.array(id).max(200),
})

/** Bounded history stays readable after merging or disabling readiness writes. */
export const releaseLineageHistorySchema = z.object({
  items: z.array(releaseLineageEntrySchema).max(50),
  nextCursor: id.nullable(),
})

/** Actionable source conflicts preserve the existing release rather than creating a duplicate. */
export const sourceSelectionErrorDetailsSchema = z.object({
  reason: z.enum([
    'SOURCE_CHANGED',
    'SOURCE_UNAVAILABLE',
    'SOURCE_ALREADY_ASSOCIATED',
    'SOURCE_ASSOCIATION_CONFLICT',
    'SOURCE_ASSOCIATION_LIMIT',
    'SOURCE_LIMIT',
  ]),
  bindingId: id.nullable(),
  releaseId: id.nullable(),
})

/** Provider evidence pinned to a facts version, independent of later selections. */
export const qualificationSourceSchema = releaseSourceSchema
  .pick({
    sourceAppId: true,
    provider: true,
    kind: true,
    repositoryId: true,
    providerObjectId: true,
  })
  .extend({ bindingId: id, observation: releaseSourceObservationSchema })

/** Immutable factual revision and its separate decision, if one exists. */
export const qualificationRevisionSchema = z.object({
  id,
  version: readinessRevisionSchema,
  parentRevisionId: id.nullable(),
  facts: releaseFactsSchema,
  authorKind: z.enum(['session', 'api_key']),
  authorId: id,
  createdAt: timestamp,
  sourceAssets: z.array(z.object({ id, fileName: z.string(), mediaType: z.string() })).max(200),
  sources: z.array(qualificationSourceSchema).max(200),
  decision: z
    .object({
      id,
      decision: qualificationDecisionSchema,
      humanUserId: id,
      reason: z.string(),
      revisitAt: timestamp.nullable(),
      createdAt: timestamp,
    })
    .nullable(),
})

/** The effective state never substitutes an older decision for changed facts. */
export const releaseQualificationSchema = z.object({
  releaseId: id,
  canonicalReleaseId: id,
  canonicalState: z.enum(['ACTIVE', 'MERGED', 'WITHDRAWN']),
  revision: readinessRevisionSchema,
  firstQualifiedAt: timestamp.nullable(),
  enabled: z.boolean(),
  needsReview: z.boolean(),
  state: z.enum(['NEEDS_FACTS', 'QUALIFIED', 'NO_COMMUNICATION', 'DEFERRED', 'WITHDRAWN']),
  current: qualificationRevisionSchema.nullable(),
  missingFacts: z.array(qualificationBlockerSchema),
})

/** Editable release-fact payload. */
export type ReleaseFacts = z.infer<typeof releaseFactsSchema>
/** Revision command accepted by the Go domain. */
export type CreateQualificationInput = z.infer<typeof createQualificationSchema>
/** Human decision command accepted by the Go domain. */
export type DecideQualificationInput = z.infer<typeof decideQualificationSchema>
/** Current release qualification and repair actions. */
export type ReleaseQualification = z.infer<typeof releaseQualificationSchema>
/** A saved version remains readable after newer facts or decisions are recorded. */
export type QualificationRevision = z.infer<typeof qualificationRevisionSchema>
/** Source selection command validated at both transport boundaries. */
export type SelectReleaseSourcesInput = z.infer<typeof selectReleaseSourcesSchema>
/** Safe source record for the inbox and release detail. */
export type ReleaseSource = z.infer<typeof releaseSourceSchema>
/** Retained evidence displayed by a historical qualification. */
export type QualificationSource = z.infer<typeof qualificationSourceSchema>
/** Human merge command accepted by the Go domain. */
export type MergeReleaseInput = z.infer<typeof mergeReleaseSchema>
/** Human split command accepted by the Go domain. */
export type SplitReleaseInput = z.infer<typeof splitReleaseSchema>
/** A recorded source grouping change. */
export type ReleaseLineageEntry = z.infer<typeof releaseLineageEntrySchema>
