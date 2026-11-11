import 'server-only'

import type {
  BackendLaunchPlan,
  BackendLaunchRevision,
  BackendLaunchSpec,
  BrandProfile,
  WritingContext,
} from 'screenshot-studio-backend-sdk'
import { type AuditMetadata, sanitizeAuditMetadata } from '@/lib/audit/metadata'
import type { TenantContext } from '@/lib/auth/access'
import { backendSDK, orNull } from '@/lib/backend/sdk'
import {
  type DesignChanges,
  type DesignDocument,
  definedChanges,
  parseDesignDocument,
  patchDesignDocument,
} from '@/lib/design/document'
import { type BrandKitValues, parseBrandKit } from './brand'
import type { PreferenceExamples } from './preferences-format'
import {
  type CampaignPlanContent,
  campaignPlanSchema,
  type LaunchPost,
  postRevisionSchema,
  type ReleaseSpecContent,
  releaseSpecSchema,
  type RevisionProposal,
  type SpecSectionKey,
  specSectionSchemas,
  type SpecSource,
} from './spec-schema'

/**
 * Persistence for the launch pipeline: versioned specs and plans, AI revision
 * proposals, and posts with provenance. The backend owns the rows: it scopes
 * every read to the workspace and audits every write in the same transaction.
 */

export class LaunchError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 422 | 503
  ) {
    super(message)
    this.name = 'LaunchError'
  }
}

export type ArtifactOrigin = 'ai' | 'human' | 'revision'

/** Audit metadata is flat: drop undefined values and anything that is not a primitive. */
function auditMetadata(metadata: Record<string, unknown> = {}): AuditMetadata {
  return sanitizeAuditMetadata(
    Object.fromEntries(
      Object.entries(metadata).filter(
        (entry): entry is [string, boolean | null | number | string] =>
          entry[1] === null || ['boolean', 'number', 'string'].includes(typeof entry[1])
      )
    )
  )
}

const date = (value: string | null) => (value ? new Date(value) : null)

// ------------------------------------------------------------- context --

export async function loadLaunchCampaign(tenant: TenantContext, campaignId: string) {
  return backendSDK(tenant).getLaunchCampaign(campaignId)
}

export type LaunchCampaign = Awaited<ReturnType<typeof loadLaunchCampaign>>

export function releaseSourceUrls(campaign: LaunchCampaign): string[] {
  return campaign.release?.sourceUrls ?? []
}

export type ActiveBrand = {
  kit: BrandKitValues | null
  /** The active kit's id, for handing a screenshot to the editor on brand. */
  kitId: string | null
  /** When the kit last changed; visuals made before it are off-brand. */
  kitUpdatedAt: Date | null
  profile: BrandProfile | null
  /** The workspace voice: the brand's WritingContext, for copy no social set owns. */
  voice: WritingContext | null
}

/** The newest active brand kit and the workspace's brand voice. */
export async function getActiveBrand(tenant: TenantContext): Promise<ActiveBrand> {
  const { kit, profile, voice } = await backendSDK(tenant).getLaunchBrand()
  return {
    kit: kit ? parseBrandKit(kit.name, kit.definition) : null,
    kitId: kit?.id ?? null,
    kitUpdatedAt: kit ? new Date(kit.updatedAt) : null,
    profile,
    voice: voice ?? null,
  }
}

/**
 * The workspace voice for a surface that writes public copy outside a draft or
 * set; null when the workspace has no brand profile. Any member may read it.
 */
export async function getWorkspaceVoice(tenant: TenantContext): Promise<WritingContext | null> {
  return (await backendSDK(tenant).getLaunchBrand()).voice ?? null
}

// --------------------------------------------------------------- specs --

export type StoredSpec = Omit<
  BackendLaunchSpec,
  'approvedAt' | 'content' | 'createdAt' | 'sources'
> & {
  approvedAt: Date | null
  content: ReleaseSpecContent
  createdAt: Date
  sources: SpecSource[]
}

function toSpec(row: BackendLaunchSpec): StoredSpec {
  return {
    ...row,
    approvedAt: date(row.approvedAt),
    content: releaseSpecSchema.parse(row.content),
    createdAt: new Date(row.createdAt),
    sources: (Array.isArray(row.sources) ? row.sources : []) as SpecSource[],
  }
}

export async function getReleaseSpecs(tenant: TenantContext, releaseId: string) {
  const specs = (await backendSDK(tenant).listLaunchSpecs(releaseId)).specs.map(toSpec)
  return {
    approved: specs.find((spec) => spec.status === 'APPROVED') ?? null,
    latest: specs[0] ?? null,
    versions: specs.map(({ changeSummary, createdAt, id, origin, status, version }) => ({
      changeSummary,
      createdAt,
      id,
      origin,
      status,
      version,
    })),
  }
}

export async function getSpecById(tenant: TenantContext, specId: string): Promise<StoredSpec> {
  return toSpec(await backendSDK(tenant).getLaunchSpec(specId))
}

/** The spec a campaign should work from: the approved version, else the latest draft. */
export async function getWorkingSpec(
  tenant: TenantContext,
  releaseId: string
): Promise<StoredSpec | null> {
  const { approved, latest } = await getReleaseSpecs(tenant, releaseId)
  return approved ?? latest
}

export async function saveSpecVersion(
  tenant: TenantContext,
  input: {
    changeSummary: string
    content: ReleaseSpecContent
    metadata?: Record<string, unknown>
    modelId?: string | null
    origin: ArtifactOrigin
    releaseId: string
    sources: SpecSource[]
  }
): Promise<StoredSpec> {
  const content = releaseSpecSchema.parse(input.content)
  const spec = await backendSDK(tenant).saveLaunchSpec(input.releaseId, {
    changeSummary: input.changeSummary,
    content,
    metadata: auditMetadata({
      flaggedSources: input.sources.filter((source) => source.flagged).length,
      openQuestions: content.openQuestions.length,
      ...input.metadata,
    }),
    modelId: input.modelId ?? null,
    origin: input.origin,
    sources: input.sources,
  })
  return toSpec(spec)
}

export async function approveSpec(tenant: TenantContext, specId: string): Promise<StoredSpec> {
  return toSpec(await backendSDK(tenant).approveLaunchSpec(specId))
}

// --------------------------------------------------------------- plans --

export type StoredPlan = Omit<BackendLaunchPlan, 'approvedAt' | 'content' | 'createdAt'> & {
  approvedAt: Date | null
  content: CampaignPlanContent
  createdAt: Date
}

function toPlan(row: BackendLaunchPlan): StoredPlan {
  return {
    ...row,
    approvedAt: date(row.approvedAt),
    content: campaignPlanSchema.parse(row.content),
    createdAt: new Date(row.createdAt),
  }
}

export async function getPlanById(
  tenant: TenantContext,
  campaignId: string,
  planId: string
): Promise<StoredPlan> {
  return toPlan(await backendSDK(tenant).getLaunchPlan(campaignId, planId))
}

export async function getCampaignPlans(tenant: TenantContext, campaignId: string) {
  const plans = (await backendSDK(tenant).listLaunchPlans(campaignId)).plans.map(toPlan)
  return {
    approved: plans.find((plan) => plan.status === 'APPROVED') ?? null,
    latest: plans[0] ?? null,
    versions: plans.map(({ changeSummary, createdAt, id, origin, status, version }) => ({
      changeSummary,
      createdAt,
      id,
      origin,
      status,
      version,
    })),
  }
}

export async function getWorkingPlan(
  tenant: TenantContext,
  campaignId: string
): Promise<StoredPlan | null> {
  const { approved, latest } = await getCampaignPlans(tenant, campaignId)
  return approved ?? latest
}

export async function savePlanVersion(
  tenant: TenantContext,
  input: {
    campaignId: string
    changeSummary: string
    content: CampaignPlanContent
    metadata?: Record<string, unknown>
    modelId?: string | null
    origin: ArtifactOrigin
    specId: string | null
  }
): Promise<StoredPlan> {
  const content = campaignPlanSchema.parse(input.content)
  const plan = await backendSDK(tenant).saveLaunchPlan(input.campaignId, {
    changeSummary: input.changeSummary,
    content,
    metadata: auditMetadata({
      assets: content.assets.length,
      channels: content.channels.length,
      ...input.metadata,
    }),
    modelId: input.modelId ?? null,
    origin: input.origin,
    specId: input.specId,
  })
  return toPlan(plan)
}

export async function approvePlan(tenant: TenantContext, planId: string): Promise<StoredPlan> {
  return toPlan(await backendSDK(tenant).approveLaunchPlan(planId))
}

// --------------------------------------------------------------- posts --

/**
 * Save generated copy with its provenance. Plan angles become content angles
 * (appended, so an earlier run's posts keep theirs) and each post records the
 * angle key, phase, spec version, and the spec claims it relies on.
 */
export async function saveLaunchPosts(
  tenant: TenantContext,
  input: {
    angles: CampaignPlanContent['angles']
    campaignId: string
    metadata?: Record<string, unknown>
    planVersion: number
    posts: LaunchPost[]
    specVersion: number
  }
) {
  return backendSDK(tenant).saveLaunchPosts(input.campaignId, {
    angles: input.angles.map(({ hook, key, title }) => ({ hook, key, title })),
    metadata: auditMetadata(input.metadata),
    planVersion: input.planVersion,
    posts: input.posts.map(({ angleKey, callToAction, channel, claims, copy, phase, title }) => ({
      angleKey,
      callToAction,
      channel,
      claims,
      copy,
      phase,
      title,
    })),
    specVersion: input.specVersion,
  })
}

// ----------------------------------------------------------- revisions --

export type StoredRevision = Omit<BackendLaunchRevision, 'createdAt' | 'decidedAt' | 'proposal'> & {
  createdAt: Date
  decidedAt: Date | null
  proposal: RevisionProposal
}

const toRevision = (row: BackendLaunchRevision): StoredRevision => ({
  ...row,
  createdAt: new Date(row.createdAt),
  decidedAt: date(row.decidedAt),
  proposal: row.proposal as RevisionProposal,
})

export async function createRevision(
  tenant: TenantContext,
  input: {
    campaignId: string
    comment: string
    modelId: string | null
    proposal: RevisionProposal
  }
): Promise<StoredRevision> {
  const revision = await backendSDK(tenant).createLaunchRevision(input.campaignId, {
    comment: input.comment,
    modelId: input.modelId,
    proposal: input.proposal,
  })
  return toRevision(revision)
}

export async function listRevisions(tenant: TenantContext, campaignId: string) {
  return (await backendSDK(tenant).listLaunchRevisions(campaignId)).revisions.map(toRevision)
}

export async function getRevision(
  tenant: TenantContext,
  revisionId: string
): Promise<StoredRevision> {
  return toRevision(await backendSDK(tenant).getLaunchRevision(revisionId))
}

/**
 * Apply a proposal: the primary change and the chosen related updates, all or
 * nothing, in one backend transaction that also rejects anything changed
 * since the proposal. Returns designs that need a fresh render.
 */
export async function applyRevision(
  tenant: TenantContext,
  revisionId: string,
  relatedIndexes: readonly number[]
): Promise<{ designIds: string[]; revision: StoredRevision }> {
  const backend = backendSDK(tenant)
  const revision = await getRevision(tenant, revisionId)
  if (revision.status !== 'PROPOSED')
    throw new LaunchError('This proposal was already decided.', 409)
  const chosen = relatedIndexes.map((index) => {
    const change = revision.proposal.related[index]
    if (!change) throw new LaunchError('Unknown related change.', 400)
    return change
  })
  // Validate what will be written; the design document format lives here, so
  // design changes go to the backend as patched documents.
  const designDocuments: Record<string, DesignDocument> = {}
  for (const change of [revision.proposal.primary, ...chosen]) {
    if (change.targetType === 'post') postRevisionSchema.parse(change.after)
    else if (change.targetType === 'spec_section')
      specSectionSchemas[change.targetKey as SpecSectionKey].parse(change.after)
    else if (change.targetType === 'plan') campaignPlanSchema.parse(change.after)
    else {
      const design = await orNull(backend.getDesign(change.targetId))
      if (!design) throw new LaunchError('Design not found.', 404)
      designDocuments[design.id] = patchDesignDocument(
        parseDesignDocument(design.document),
        definedChanges((change.after as { changes: DesignChanges }).changes)
      )
    }
  }
  const result = await backend.applyLaunchRevision(revisionId, {
    designDocuments,
    related: [...relatedIndexes],
  })
  return { designIds: result.designIds, revision: toRevision(result.revision) }
}

export async function discardRevision(
  tenant: TenantContext,
  revisionId: string
): Promise<StoredRevision> {
  return toRevision(await backendSDK(tenant).discardLaunchRevision(revisionId))
}

// ---------------------------------------------------------- preferences --

const plainText = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'copy' in value)
    return String((value as { copy: unknown }).copy)
  return ''
}

/** The workspace's review history, newest first, for the preferences block. */
export async function loadPreferenceExamples(tenant: TenantContext): Promise<PreferenceExamples> {
  const history = await backendSDK(tenant).getLaunchPreferences()
  const perChannel = new Map<string, number>()
  const approved = history.approved.filter((post) => {
    const count = perChannel.get(post.channel) ?? 0
    perChannel.set(post.channel, count + 1)
    return count < 2
  })
  return {
    approved: approved.slice(0, 8),
    rejected: history.rejected.map((post) => ({
      channel: post.channel,
      copy: post.copy,
      note: post.reviewNote,
      status: post.status,
    })),
    revisions: history.revisions.map((revision) => {
      const proposal = revision.proposal as RevisionProposal | null
      return {
        after: plainText(proposal?.primary.after),
        before: plainText(proposal?.primary.before),
        comment: revision.comment,
        targetType: revision.targetType,
      }
    }),
  }
}
