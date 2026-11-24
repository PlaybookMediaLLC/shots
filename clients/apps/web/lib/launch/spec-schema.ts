import { z } from 'zod'

/**
 * Schemas for the launch pipeline: the cited product spec, the campaign plan,
 * channel copy, and AI revision proposals (docs/launch-intelligence.md).
 *
 * Pure and dependency-free so the model tools, the API, the editor UI, and the
 * unit tests all validate against the same definitions.
 */

/** "brief" (what a person entered) or a fetched source id, S1–S99. */
export const sourceRefSchema = z
  .string()
  .regex(
    /^(brief|S[1-9][0-9]?|evidence:[A-Za-z0-9_-]{1,128})$/,
    'Cite "brief" or a source id such as S1.'
  )

const text = (max: number) => z.string().trim().min(1).max(max)
const sourceRefs = z.array(sourceRefSchema).min(1, 'Cite at least one source.').max(6)

const stableClaimIdentity = {
  claimId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
  claimVersionId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
}

export const specClaimSchema = z.object({
  ...stableClaimIdentity,
  sources: sourceRefs,
  text: text(600),
})

export const SPEC_SECTIONS = [
  'summary',
  'problem',
  'audience',
  'whatChanged',
  'capabilities',
  'beforeAfter',
  'proofPoints',
  'limitations',
  'faqs',
  'messaging',
  'openQuestions',
] as const
export type SpecSectionKey = (typeof SPEC_SECTIONS)[number]

export const SPEC_SECTION_LABELS: Record<SpecSectionKey, string> = {
  audience: 'Who it is for',
  beforeAfter: 'Before and after',
  capabilities: 'Key capabilities',
  faqs: 'FAQs',
  limitations: 'Limitations',
  messaging: 'Messaging',
  openQuestions: 'Open questions',
  problem: 'Problem',
  proofPoints: 'Proof points',
  summary: 'Summary',
  whatChanged: 'What changed',
}

export const specSectionSchemas = {
  audience: z
    .array(
      z.object({ ...stableClaimIdentity, need: text(500), segment: text(160), sources: sourceRefs })
    )
    .max(6),
  beforeAfter: z
    .array(
      z.object({ ...stableClaimIdentity, after: text(400), before: text(400), sources: sourceRefs })
    )
    .max(6),
  capabilities: z
    .array(
      z.object({
        ...stableClaimIdentity,
        description: text(600),
        name: text(120),
        sources: sourceRefs,
      })
    )
    .max(10),
  faqs: z
    .array(
      z.object({
        ...stableClaimIdentity,
        answer: text(800),
        question: text(300),
        sources: sourceRefs,
      })
    )
    .max(10),
  limitations: z.array(specClaimSchema).max(8),
  messaging: z.object({
    ctas: z.array(text(120)).max(5),
    pillars: z
      .array(
        z.object({
          ...stableClaimIdentity,
          message: text(500),
          sources: sourceRefs,
          title: text(120),
        })
      )
      .max(5),
    positioning: z.object({
      ...stableClaimIdentity,
      alternatives: z.array(text(120)).max(6),
      sources: z.array(sourceRefSchema).max(6),
      statement: z.string().trim().max(800),
    }),
  }),
  openQuestions: z
    .array(
      z.object({
        /** Filled in by a person; answered questions feed the next draft as part of the brief. */
        answer: z.string().trim().max(1_000).default(''),
        question: text(300),
        reason: z.string().trim().max(400),
        section: z.enum(SPEC_SECTIONS),
      })
    )
    .max(15),
  problem: z.array(specClaimSchema).max(6),
  proofPoints: z.array(specClaimSchema).max(8),
  summary: z.object({ ...stableClaimIdentity, sources: sourceRefs, text: text(1_200) }),
  whatChanged: z.array(specClaimSchema).max(10),
} satisfies Record<SpecSectionKey, z.ZodType>

export const releaseSpecSchema = z.object(specSectionSchemas)
export type ReleaseSpecContent = z.infer<typeof releaseSpecSchema>
export type SpecClaim = z.infer<typeof specClaimSchema>

export const SOURCE_KINDS = [
  'brief',
  'changelog',
  'pull_request',
  'release',
  'docs',
  'product_page',
  'page',
] as const

/** What the spec's citations point at, stored with each spec version. */
export const specSourceSchema = z.object({
  /** Up to ~1,500 characters shown when a reviewer opens a citation. */
  excerpt: z.string(),
  fetchedAt: z.string(),
  flagged: z.boolean(),
  /** Why the source was flagged as a possible prompt injection. */
  flags: z.array(z.string()),
  id: z.string(),
  kind: z.enum(SOURCE_KINDS),
  /** Headings with ids on the page; a capture may target url#id. */
  sections: z.array(z.object({ id: z.string(), title: z.string() })).default([]),
  status: z.enum(['ok', 'blocked', 'failed', 'empty']),
  /** Why a source could not be read, for the reviewer. */
  statusReason: z.string().default(''),
  title: z.string(),
  url: z.string(),
})
export type SpecSource = z.infer<typeof specSourceSchema>

// ---------------------------------------------------------------- claims --

/** A path to one claim in a spec, e.g. "capabilities.1" or "messaging.pillars.0". */
export const claimRefSchema = z
  .string()
  .regex(
    /^(claim:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128}|summary|messaging\.positioning|(problem|audience|whatChanged|capabilities|beforeAfter|proofPoints|limitations|faqs|messaging\.pillars)\.\d{1,2})$/,
    'Reference a spec claim such as capabilities.0, proofPoints.1, or messaging.pillars.0.'
  )

export type SpecClaimEntry = {
  ref: string
  section: SpecSectionKey
  text: string
  versionedRef?: string
}

function versionedClaimRef(identity: {
  claimId?: string
  claimVersionId?: string
}): string | undefined {
  return identity.claimId && identity.claimVersionId
    ? `claim:${identity.claimId}:${identity.claimVersionId}`
    : undefined
}

/** Every citable claim in a spec with its ref, for prompts and provenance checks. */
export function listSpecClaims(spec: ReleaseSpecContent): SpecClaimEntry[] {
  const entries: SpecClaimEntry[] = [
    {
      ref: 'summary',
      section: 'summary',
      text: spec.summary.text,
      versionedRef: versionedClaimRef(spec.summary),
    },
  ]
  const push = (
    section: SpecSectionKey,
    prefix: string,
    texts: string[],
    identities: { claimId?: string; claimVersionId?: string }[]
  ) =>
    texts.forEach((value, index) =>
      entries.push({
        ref: `${prefix}.${index}`,
        section,
        text: value,
        versionedRef: versionedClaimRef(identities[index]),
      })
    )
  push(
    'problem',
    'problem',
    spec.problem.map((claim) => claim.text),
    spec.problem
  )
  push(
    'audience',
    'audience',
    spec.audience.map((item) => `${item.segment}: ${item.need}`),
    spec.audience
  )
  push(
    'whatChanged',
    'whatChanged',
    spec.whatChanged.map((claim) => claim.text),
    spec.whatChanged
  )
  push(
    'capabilities',
    'capabilities',
    spec.capabilities.map((item) => `${item.name}: ${item.description}`),
    spec.capabilities
  )
  push(
    'beforeAfter',
    'beforeAfter',
    spec.beforeAfter.map((item) => `Before: ${item.before} After: ${item.after}`),
    spec.beforeAfter
  )
  push(
    'proofPoints',
    'proofPoints',
    spec.proofPoints.map((claim) => claim.text),
    spec.proofPoints
  )
  push(
    'limitations',
    'limitations',
    spec.limitations.map((claim) => claim.text),
    spec.limitations
  )
  push(
    'faqs',
    'faqs',
    spec.faqs.map((item) => `${item.question} ${item.answer}`),
    spec.faqs
  )
  push(
    'messaging',
    'messaging.pillars',
    spec.messaging.pillars.map((pillar) => `${pillar.title}: ${pillar.message}`),
    spec.messaging.pillars
  )
  if (spec.messaging.positioning.statement) {
    entries.push({
      ref: 'messaging.positioning',
      section: 'messaging',
      text: spec.messaging.positioning.statement,
      versionedRef: versionedClaimRef(spec.messaging.positioning),
    })
  }
  return entries
}

export function resolveClaimRef(spec: ReleaseSpecContent, ref: string): SpecClaimEntry | null {
  return (
    listSpecClaims(spec).find((entry) => entry.ref === ref || entry.versionedRef === ref) ?? null
  )
}

/**
 * Whether claim refs mean the same in two spec versions: each resolves in
 * both, to the same text. This is a compatibility check only; factual support
 * still requires an exact human decision in the release evidence graph.
 */
export function claimsMeanTheSame(
  refs: readonly string[],
  from: ReleaseSpecContent,
  to: ReleaseSpecContent
): boolean {
  return refs.every((ref) => {
    const before = resolveClaimRef(from, ref)
    const after = resolveClaimRef(to, ref)
    return before !== null && after !== null && before.text.trim() === after.text.trim()
  })
}

/** The spec section a claim ref belongs to. */
export function claimRefSection(ref: string, spec?: ReleaseSpecContent): SpecSectionKey | null {
  if (ref.startsWith('claim:')) return spec ? (resolveClaimRef(spec, ref)?.section ?? null) : null
  const head = ref.split('.')[0] as SpecSectionKey
  return (SPEC_SECTIONS as readonly string[]).includes(head) ? head : null
}

// ------------------------------------------------------------------ plan --

export const LAUNCH_CHANNELS = [
  'x',
  'linkedin',
  'product_hunt',
  'changelog',
  'email',
  'instagram',
] as const
export type LaunchChannel = (typeof LAUNCH_CHANNELS)[number]

export const LAUNCH_CHANNEL_LABELS: Record<LaunchChannel, string> = {
  changelog: 'Changelog',
  email: 'Email',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  product_hunt: 'Product Hunt',
  x: 'X',
}

export const PLAN_PHASES = ['teaser', 'launch', 'follow_up'] as const
export type PlanPhase = (typeof PLAN_PHASES)[number]
export const PLAN_PHASE_LABELS: Record<PlanPhase, string> = {
  follow_up: 'Follow-up',
  launch: 'Launch day',
  teaser: 'Teaser',
}

export const ASSET_KINDS = ['hero', 'feature_shot', 'social_card', 'story'] as const
export const ASSET_FORMATS = ['16:9', '1:1', '4:5', '9:16'] as const

const angleKey = z.string().regex(/^G\d{1,2}$/, 'Angle keys look like G1.')
const assetKey = z.string().regex(/^A\d{1,2}$/, 'Asset keys look like A1.')

export const campaignPlanSchema = z.object({
  angles: z
    .array(
      z.object({
        hook: text(400),
        key: angleKey,
        /** The messaging pillar or capability the angle carries. */
        pillar: text(160),
        specRefs: z.array(claimRefSchema).min(1).max(4),
        title: text(120),
      })
    )
    .min(1)
    .max(5),
  assets: z
    .array(
      z.object({
        angleKey,
        /** Which spec capability the asset shows. */
        capability: text(160),
        captureHint: z.object({
          device: z.enum(['desktop', 'mobile']),
          /** What to show: the screen, panel, or flow that proves the capability. */
          focus: text(300),
          /** A registered product or source URL; empty means the main product URL. */
          url: z.string().trim().max(2_000),
        }),
        format: z.enum(ASSET_FORMATS),
        /** A short benefit-led headline for the visual. */
        headline: text(70),
        key: assetKey,
        kind: z.enum(ASSET_KINDS),
        /** Two variants make an A/B pair that differs in one idea. */
        variants: z.number().int().min(1).max(2),
      })
    )
    .min(1)
    .max(8),
  channels: z
    .array(
      z.object({
        cadence: text(200),
        channel: z.enum(LAUNCH_CHANNELS),
        role: text(300),
      })
    )
    .min(1)
    .max(6),
  summary: text(800),
  timeline: z
    .array(
      z.object({
        angleKey,
        assetKeys: z.array(assetKey).max(3),
        channel: z.enum(LAUNCH_CHANNELS),
        /** Days relative to launch day (0); negative is a teaser before launch. */
        day: z.number().int().min(-30).max(60),
        note: z.string().trim().max(300),
        phase: z.enum(PLAN_PHASES),
      })
    )
    .min(1)
    .max(24),
})
export type CampaignPlanContent = z.infer<typeof campaignPlanSchema>

/**
 * A capture URL is a registered URL, optionally with a section fragment
 * (url#heading-id) so the page scrolls to the part the asset shows. The
 * fragment cannot change the host or path.
 */
export function isRegisteredCaptureUrl(url: string, allowedUrls: readonly string[]): boolean {
  const hash = url.indexOf('#')
  if (hash === -1) return allowedUrls.includes(url)
  return allowedUrls.includes(url.slice(0, hash)) && /^#[A-Za-z][\w-]{0,99}$/.test(url.slice(hash))
}

/** Cross-reference problems in a plan: unknown angles, assets, channels, claims, or URLs. */
export function validatePlanReferences(
  plan: CampaignPlanContent,
  spec: ReleaseSpecContent,
  allowedUrls: readonly string[]
): string[] {
  const issues: string[] = []
  const angles = new Set(plan.angles.map((angle) => angle.key))
  const assets = new Set(plan.assets.map((asset) => asset.key))
  const channels = new Set(plan.channels.map((channel) => channel.channel))
  const unique = (keys: string[], label: string) => {
    const seen = new Set<string>()
    for (const key of keys) {
      if (seen.has(key)) issues.push(`${label} ${key} is used twice.`)
      seen.add(key)
    }
  }
  unique(
    plan.angles.map((angle) => angle.key),
    'Angle key'
  )
  unique(
    plan.assets.map((asset) => asset.key),
    'Asset key'
  )
  for (const angle of plan.angles) {
    for (const ref of angle.specRefs) {
      if (!resolveClaimRef(spec, ref))
        issues.push(`Angle ${angle.key} cites ${ref}, which is not in the spec.`)
    }
  }
  for (const asset of plan.assets) {
    if (!angles.has(asset.angleKey))
      issues.push(`Asset ${asset.key} uses unknown angle ${asset.angleKey}.`)
    if (asset.captureHint.url && !isRegisteredCaptureUrl(asset.captureHint.url, allowedUrls)) {
      issues.push(
        `Asset ${asset.key} captures ${asset.captureHint.url}, which is not a registered URL.`
      )
    }
  }
  plan.timeline.forEach((item, index) => {
    const label = `Timeline item ${index + 1}`
    if (!angles.has(item.angleKey)) issues.push(`${label} uses unknown angle ${item.angleKey}.`)
    if (!channels.has(item.channel))
      issues.push(`${label} posts to ${item.channel}, which is not a plan channel.`)
    for (const key of item.assetKeys) {
      if (!assets.has(key)) issues.push(`${label} uses unknown asset ${key}.`)
    }
    const expected = item.day < 0 ? 'teaser' : item.day === 0 ? 'launch' : 'follow_up'
    if (item.phase !== expected)
      issues.push(`${label} is day ${item.day}, so its phase is ${expected}.`)
  })
  return issues
}

// ------------------------------------------------------------------ copy --

export const launchPostSchema = z.object({
  angleKey,
  callToAction: z.string().trim().max(300),
  channel: z.enum(LAUNCH_CHANNELS),
  /** The spec claims this post relies on. Every factual statement needs one. */
  claims: z
    .array(z.object({ ref: claimRefSchema, text: text(300) }))
    .min(1, 'List the spec claims the post relies on.')
    .max(6),
  copy: text(5_000),
  phase: z.enum(PLAN_PHASES),
  /** Email subject, Product Hunt tagline, or changelog heading; empty for social posts. */
  title: z.string().trim().max(120),
})
export type LaunchPost = z.infer<typeof launchPostSchema>

// ------------------------------------------------------------- revisions --

export const REVISION_TARGETS = ['spec_section', 'post', 'design', 'plan'] as const
export type RevisionTarget = (typeof REVISION_TARGETS)[number]

/** The editable part of a post that a revision may change. */
export const postRevisionSchema = launchPostSchema.pick({
  callToAction: true,
  claims: true,
  copy: true,
  title: true,
})
export type PostRevision = z.infer<typeof postRevisionSchema>

export type RevisionChange = {
  /** What the change is, in the reviewer's terms. */
  label: string
  reason: string
  targetId: string
  targetKey?: string | null
  targetType: RevisionTarget
  before: unknown
  after: unknown
}

export type RevisionProposal = {
  primary: RevisionChange
  /** Consistency updates for pieces that depend on the primary change. */
  related: RevisionChange[]
  summary: string
}
