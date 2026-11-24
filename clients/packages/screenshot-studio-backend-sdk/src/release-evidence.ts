import { z } from 'zod'
import { readinessRevisionSchema } from './release-readiness.ts'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const sequence = readinessRevisionSchema.refine((value) => value !== '0')
const timestamp = z.iso.datetime({ offset: true })
const boundedText = (bytes: number) =>
  z
    .string()
    .max(bytes)
    .refine(
      (value) =>
        new TextEncoder().encode(value).length <= bytes &&
        !value.includes('\0') &&
        [...value].every((character) => {
          const code = character.codePointAt(0) ?? 0
          return code < 0xd800 || code > 0xdfff
        })
    )
const requiredText = (bytes: number) =>
  boundedText(bytes).refine((value) => value.trim().length > 0)

/** Durable references returned by every evidence and material command. */
export const readinessMutationSchema = z.object({
  created: z.boolean(),
  revision: readinessRevisionSchema,
  id,
  ids: z.array(id),
})
/** Explicit provenance never grants factual verification. */
export const evidenceOriginSchema = z.enum(['HUMAN', 'PROVIDER', 'AI'])
/** Evidence starts private; customer clearance is a separate human command. */
export const evidenceAccessClassSchema = z.enum([
  'PRIVATE_SOURCE',
  'INTERNAL_MATERIAL',
  'CUSTOMER_CLEARED',
])
/** Availability and audience conditions are part of the immutable claim hash. */
export const claimQualifiersSchema = z.strictObject({
  audience: boundedText(4096),
  availability: boundedText(4096),
  eligibility: boundedText(4096),
  limitations: boundedText(4096),
})
/** Selector offsets address retained UTF-8 bytes, never JavaScript character offsets. */
export const evidenceSelectorSchema = z.strictObject({
  kind: z.enum(['TEXT_SPAN', 'IMAGE_REGION']),
  contextSha256: hash,
  startByte: z.number().int().nonnegative().max(262144).optional(),
  endByte: z.number().int().positive().max(262144).optional(),
  quoteSha256: hash.optional(),
  x: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  y: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  width: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  height: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  redactionId: id.optional(),
})
/** Human support decisions apply to the exact claim and support set. */
export const claimDecisionSchema = z.enum(['SUPPORTED', 'CONTRADICTED', 'UNRESOLVED', 'WITHDRAWN'])
/** Bounded snapshots reuse owned images or already retained provider observations. */
export const createReleaseEvidenceSchema = z
  .strictObject({
    expectedRevision: readinessRevisionSchema,
    sourceId: id.nullable().default(null),
    expectedSourceSequence: sequence.nullable().default(null),
    kind: z.enum(['TEXT', 'ATTESTATION', 'ASSET', 'RELEASE_SOURCE']),
    origin: evidenceOriginSchema,
    text: boundedText(262144).default(''),
    sourceUrl: z
      .url({ protocol: /^https?$/ })
      .max(2000)
      .nullable()
      .default(null),
    observedAt: timestamp.nullable(),
    purpose: requiredText(1000),
    attestationScope: boundedText(8192).default(''),
    limitations: boundedText(8192).default(''),
    confirmAttestation: z.boolean().default(false),
    assetId: id.nullable().default(null),
    redactionAssetId: id.nullable().default(null),
    sourceBindingId: id.nullable().default(null),
    observationId: id.nullable().default(null),
  })
  .refine((value) => (value.sourceId === null) === (value.expectedSourceSequence === null), {
    message: 'A source replacement needs its current sequence.',
  })
/** Attach a retained workspace snapshot to another release without copying bytes. */
export const linkReleaseEvidenceSchema = z.strictObject({
  expectedRevision: readinessRevisionSchema,
  evidenceVersionId: id,
  expectedSourceSequence: sequence,
  purpose: requiredText(1000),
})
/** Clearance and erasure advance the shared source fence synchronously. */
export const changeEvidenceAccessSchema = z.strictObject({
  expectedRevision: readinessRevisionSchema,
  evidenceVersionId: id,
  expectedSourceSequence: sequence,
  action: z.enum(['CLEAR_FOR_AUDIENCE', 'REVOKE_CLEARANCE', 'WITHDRAW', 'TOMBSTONE']),
  audienceIds: z.array(id).max(20),
  reason: requiredText(8192),
})
/** An edit preserves claim identity but appends an unresolved immutable version. */
export const saveReleaseClaimSchema = z
  .strictObject({
    expectedRevision: readinessRevisionSchema,
    claimId: id.nullable().default(null),
    expectedClaimVersionId: id.nullable().default(null),
    text: requiredText(4096),
    qualifiers: claimQualifiersSchema,
    origin: z.enum(['HUMAN', 'AI']),
  })
  .refine((value) => (value.claimId === null) === (value.expectedClaimVersionId === null), {
    message: 'An existing claim needs its current version.',
  })
/** Contradictory passages stay in the set or carry an explicit exclusion reason. */
export const claimSupportInputSchema = z.strictObject({
  evidenceVersionId: id,
  expectedSourceSequence: sequence,
  relation: z.enum(['SUPPORTS', 'CONTRADICTS', 'CONTEXT']),
  selector: evidenceSelectorSchema,
  exclusionReason: boundedText(8192).default(''),
})
/** Replacing the support set clears only this claim's current verification. */
export const setClaimSupportsSchema = z.strictObject({
  expectedRevision: readinessRevisionSchema,
  claimVersionId: id,
  supports: z.array(claimSupportInputSchema).max(20),
})
/** Only the assigned current human reviewer may issue this command. */
export const verifyReleaseClaimSchema = z.strictObject({
  expectedRevision: readinessRevisionSchema,
  claimVersionId: id,
  claimSha256: hash,
  supportSetId: id,
  supportSha256: hash,
  decision: claimDecisionSchema,
  reason: requiredText(8192),
})
/** Importing a historical approval creates unverified claim coverage. */
export const importReleaseSpecClaimsSchema = z.strictObject({
  expectedRevision: readinessRevisionSchema,
  specId: id.nullable().default(null),
})
/** Source content is nullable after access loss, erasure or machine redaction. */
export const releaseEvidenceSchema = z.object({
  id,
  sourceId: id,
  version: sequence,
  sourceSequence: sequence,
  kind: z.enum(['TEXT', 'ATTESTATION', 'ASSET', 'RELEASE_SOURCE']),
  format: z.enum(['TEXT', 'IMAGE']),
  origin: evidenceOriginSchema,
  accessClass: evidenceAccessClassSchema,
  available: z.boolean(),
  current: z.boolean(),
  sha256: hash,
  normalizationVersion: z.string(),
  providerRevision: z.string(),
  text: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  assetId: id.nullable(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  redactionAssetId: id.nullable(),
  observedAt: timestamp,
  createdAt: timestamp,
  confirmedByUserId: id.nullable(),
  confirmedAt: timestamp.nullable(),
  attestationScope: z.string().nullable(),
  limitations: z.string().nullable(),
  tombstonedAt: timestamp.nullable(),
})
/** Canonical support pins include exact evidence versions and acknowledged source sequences. */
export const claimSupportReferenceSchema = z.object({
  evidenceVersionId: id,
  evidenceSha256: hash,
  sourceId: id,
  sourceSequence: sequence,
  relation: z.enum(['SUPPORTS', 'CONTRADICTS', 'CONTEXT']),
  selector: evidenceSelectorSchema,
  exclusionReason: z.string(),
})
/** A current projection preserves historical decisions while explaining invalidation. */
export const releaseClaimSchema = z.object({
  id,
  versionId: id,
  version: sequence,
  specId: id.nullable(),
  text: z.string(),
  qualifiers: claimQualifiersSchema,
  origin: evidenceOriginSchema,
  sha256: hash,
  supportSetId: id.nullable(),
  supportSha256: hash.nullable(),
  supports: z.array(claimSupportReferenceSchema).max(20),
  evidence: z.array(releaseEvidenceSchema).max(20),
  decision: z
    .object({
      id,
      decision: claimDecisionSchema,
      humanUserId: z.string(),
      reason: z.string(),
      createdAt: timestamp,
    })
    .nullable(),
  state: claimDecisionSchema,
  blockers: z.array(z.string()),
  createdAt: timestamp,
})
/** Opaque keyset cursors are scoped by the release path. */
export const releaseEvidencePageSchema = z.object({
  items: z.array(releaseEvidenceSchema).max(50),
  nextCursor: z.string().max(1024).nullable(),
})
/** Current claims and permitted excerpts in a bounded page. */
export const releaseClaimsPageSchema = z.object({
  importProgress: z.object({
    cursor: z.string(),
    imported: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
    done: z.boolean(),
    invalidSpecIds: z.array(id),
  }),
  items: z.array(releaseClaimSchema).max(50),
  nextCursor: z.string().max(1024).nullable(),
})

/** Evidence mutation accepted by Go. */
export type CreateReleaseEvidenceInput = z.infer<typeof createReleaseEvidenceSchema>
/** A release-to-snapshot binding command. */
export type LinkReleaseEvidenceInput = z.infer<typeof linkReleaseEvidenceSchema>
/** Human source access decision. */
export type ChangeEvidenceAccessInput = z.infer<typeof changeEvidenceAccessSchema>
/** Stable claim creation or edit. */
export type SaveReleaseClaimInput = z.infer<typeof saveReleaseClaimSchema>
/** Exact support set replacement. */
export type SetClaimSupportsInput = z.infer<typeof setClaimSupportsSchema>
/** Assigned human factual decision. */
export type VerifyReleaseClaimInput = z.infer<typeof verifyReleaseClaimSchema>
/** Historical spec import command. */
export type ImportReleaseSpecClaimsInput = z.infer<typeof importReleaseSpecClaimsSchema>
/** Safe evidence view. */
export type ReleaseEvidence = z.infer<typeof releaseEvidenceSchema>
/** Current claim review view. */
export type ReleaseClaim = z.infer<typeof releaseClaimSchema>
/** Canonical selector for retained text or image pixels. */
export type EvidenceSelector = z.infer<typeof evidenceSelectorSchema>
