import { z } from 'zod'
import { readinessRevisionSchema, releaseMaterialSchema } from './release-readiness.ts'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const rationale = z
  .string()
  .trim()
  .min(1)
  .max(8192)
  .refine((value) => new TextEncoder().encode(value).length <= 8192)

/** One assertion in an owned native document, pinned to the current claim version. */
export const kitClaimInputSchema = z.strictObject({
  nodeId: z.string().trim().min(1).max(128),
  claimVersionId: id,
})

/** Reuse a prepared artifact, or snapshot an acknowledged native source. */
export const kitArtifactInputSchema = z.union([
  z.strictObject({ existingArtifactId: id }),
  z
    .strictObject({
      existingArtifactId: z.null().default(null),
      kind: releaseMaterialSchema,
      audienceId: id,
      classification: z.enum(['INTERNAL_MATERIAL', 'CUSTOMER_CLEARED']),
      sourceKind: z.enum(['TEMPLATE', 'DRAFT', 'ASSET', 'CREATIVE']),
      sourceId: z.string().max(128).default(''),
      expectedNativeRevision: z.string().max(64).default(''),
      outputId: z.string().max(128).default(''),
      claims: z.array(kitClaimInputSchema).max(100),
    })
    .superRefine((value, ctx) => {
      if (value.sourceKind !== 'TEMPLATE' && (!value.sourceId || !value.expectedNativeRevision)) {
        ctx.addIssue({
          code: 'custom',
          path: ['expectedNativeRevision'],
          message: 'Save the source and acknowledge its current revision first.',
        })
      }
      if (
        (value.sourceKind === 'ASSET' || value.sourceKind === 'CREATIVE') !==
        (value.kind === 'SCREENSHOT')
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['kind'],
          message: 'Use an owned image or creative output for screenshots.',
        })
      }
    }),
])

/** Assemble the primary kit or explicitly replace its current revision. */
export const createReleaseKitSchema = z.strictObject({
  expectedRevision: readinessRevisionSchema,
  expectedKitRevisionId: id.nullable(),
  qualificationRevisionId: id,
  approverUserId: id,
  artifacts: z.array(kitArtifactInputSchema).min(1).max(50),
})
/** Input to manual kit assembly. */
export type CreateReleaseKitInput = z.infer<typeof createReleaseKitSchema>
/** One selected immutable artifact or native source. */
export type KitArtifactInput = z.infer<typeof kitArtifactInputSchema>

/** Acknowledge all immutable input snapshots before preparing their outputs. */
export const prepareReleaseKitSchema = z.strictObject({
  expectedRevision: readinessRevisionSchema,
  snapshots: z
    .array(z.strictObject({ artifactRevisionId: id, snapshotSha256: hash }))
    .min(1)
    .max(50),
})
/** Input to durable output preparation. */
export type PrepareReleaseKitInput = z.infer<typeof prepareReleaseKitSchema>

/** Coverage and final approval are separate human decisions over exact prepared bytes. */
export const decideReleaseKitSchema = z
  .strictObject({
    expectedRevision: readinessRevisionSchema,
    manifestSha256: hash,
    dependencyToken: hash,
    reviewType: z.enum(['CONTENT_COVERAGE', 'FINAL_APPROVAL']),
    decision: z.enum(['APPROVE', 'REJECT', 'WITHDRAW']),
    reason: rationale,
    assertionsConfirmed: z.boolean(),
    screenshotsConfirmed: z.boolean(),
    audienceConfirmed: z.boolean(),
  })
  .refine(
    (value) =>
      value.reviewType !== 'CONTENT_COVERAGE' ||
      value.decision !== 'APPROVE' ||
      (value.assertionsConfirmed && value.screenshotsConfirmed && value.audienceConfirmed),
    { message: 'Confirm assertions, screenshots and audience safety before approving coverage.' }
  )
/** Input to a session-only human kit decision. */
export type DecideReleaseKitInput = z.infer<typeof decideReleaseKitSchema>

/** Request cached approved bytes for explicit audiences; the backend rechecks readiness. */
export const requestKitExportSchema = z.strictObject({
  expectedRevision: readinessRevisionSchema,
  manifestSha256: hash,
  audienceIds: z
    .array(id)
    .min(1)
    .max(20)
    .refine((values) => new Set(values).size === values.length),
})
/** Input to an approved ZIP export request. */
export type RequestKitExportInput = z.infer<typeof requestKitExportSchema>

/** Stable repair details; excerpts and credentials never belong in a blocker. */
export const kitBlockerSchema = z.object({
  code: z.enum([
    'QUALIFICATION_REQUIRED',
    'AVAILABILITY_UNCONFIRMED',
    'CLAIM_UNVERIFIED',
    'EVIDENCE_UNAVAILABLE',
    'SOURCE_CHANGED',
    'MATERIAL_MISSING',
    'COVERAGE_UNREVIEWED',
    'SCREENSHOT_UNREVIEWED',
    'AUDIENCE_LEAK',
    'OUTPUT_INCOMPLETE',
    'APPROVAL_REQUIRED',
    'APPROVER_REVOKED',
    'REVISION_SUPERSEDED',
  ]),
  objectId: z.string(),
  audienceId: z.string().nullable(),
  ownerId: z.string().nullable(),
  repairAction: z.string(),
})
/** Advisory readiness; every use is authorized again at the backend boundary. */
export const kitReadinessSchema = z.object({
  canApprove: z.boolean(),
  canExportApproved: z.boolean(),
  canRequestHandoff: z.boolean(),
  manifestHash: hash.nullable(),
  aggregateRevision: readinessRevisionSchema,
  dependencyToken: hash,
  policyVersion: z.number().int().positive(),
  blockers: z.array(kitBlockerSchema),
})
/** Computed readiness over current authority and exact immutable dependencies. */
export type KitReadiness = z.infer<typeof kitReadinessSchema>

/** Typed kit conflict preserved through the public API error adapter. */
export const kitReadinessErrorDetailsSchema = z.object({
  reason: z.enum(['KIT_NOT_READY', 'SOURCE_CHANGED']),
  currentRevision: readinessRevisionSchema,
  blockers: z.array(kitBlockerSchema),
})

/** The exact human decision and support set pinned by an artifact assertion. */
export const kitClaimLinkSchema = z.object({
  nodeId: z.string(),
  claimId: id,
  claimVersionId: id,
  supportSetId: z.string(),
  verificationId: z.string(),
})

/** Immutable candidate or reviewed revision, with machine reads redacted by Go. */
export const releaseKitSchema = z.object({
  id,
  kitId: id,
  history: z.array(z.object({ id, version: readinessRevisionSchema, state: z.string() })),
  exportIds: z.array(id),
  version: readinessRevisionSchema,
  state: z.enum([
    'DRAFT',
    'BUILDING',
    'REVIEWABLE',
    'APPROVED',
    'REJECTED',
    'SUPERSEDED',
    'WITHDRAWN',
    'FAILED',
  ]),
  approverUserId: id,
  qualificationRevisionId: id,
  failureCode: z.string(),
  artifacts: z.array(
    z.object({
      id,
      kind: releaseMaterialSchema,
      audienceId: id,
      classification: z.enum(['INTERNAL_MATERIAL', 'CUSTOMER_CLEARED']),
      sourceKind: z.enum(['TEMPLATE', 'DRAFT', 'ASSET', 'CREATIVE']),
      sourceId: z.string(),
      sourceRevision: z.string(),
      snapshotSha256: hash,
      outputSha256: hash.nullable(),
      claims: z.array(kitClaimLinkSchema),
      prepared: z.boolean(),
      document: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown()), z.null()]),
      markdown: z.string().nullable(),
    })
  ),
  omissions: z.array(
    z.object({
      audienceId: id,
      material: releaseMaterialSchema,
      ownerId: z.string(),
      reason: z.string(),
    })
  ),
  decisions: z.array(
    z.object({
      id,
      reviewType: z.enum(['CONTENT_COVERAGE', 'FINAL_APPROVAL']),
      decision: z.enum(['APPROVE', 'REJECT', 'WITHDRAW']),
      humanUserId: z.string(),
      reason: z.string(),
      manifestSha256: hash,
      createdAt: z.iso.datetime({ offset: true }),
    })
  ),
  readiness: kitReadinessSchema,
})
/** A release kit read model. */
export type ReleaseKit = z.infer<typeof releaseKitSchema>

/** Customer-facing metadata contains only safe files and release identity. */
export const kitPublicIndexSchema = z.object({
  schemaVersion: z.literal(1),
  releaseId: id,
  kitRevisionId: id,
  audienceIds: z.array(id),
  files: z.array(
    z.object({ name: z.string(), sha256: hash, byteLength: z.number().int().nonnegative() })
  ),
})
/** Stored export; a download URL is minted only after current readiness is rechecked. */
export const kitExportSchema = z.object({
  id,
  state: z.enum(['BUILDING', 'READY', 'FAILED']),
  sha256: hash.nullable(),
  failureCode: z.string(),
  fileIndex: kitPublicIndexSchema,
  downloadUrl: z.url({ protocol: /^https?$/ }).nullable(),
})
/** Export status and a separately authorized download capability. */
export type KitExport = z.infer<typeof kitExportSchema>

/** Authenticated prepared bytes for the private preview adapter only. */
export const kitArtifactPreviewSchema = z.object({
  body: z.string(),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'text/markdown; charset=utf-8']),
})
/** Watermarked private preview; never an approved export link. */
export const kitPreviewSchema = z.object({
  kind: z.enum(['image', 'text']),
  content: z.string(),
  watermark: z.literal('PREVIEW — NOT APPROVED FOR DISTRIBUTION'),
})
