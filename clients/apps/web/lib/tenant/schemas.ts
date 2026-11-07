import { uploadByteLimit, MEDIA_LIMITS } from '@/lib/write/media-limits'
import { z } from 'zod'
import { brandKitEditorSchema } from '@/lib/brand/editor-definition'
import { fontFamilies } from '@/lib/constants/fonts'
import { assetClassifications } from './object-key'

const contentTypeSchema = z
  .string()
  .trim()
  .regex(
    /^(image\/(gif|jpeg|png|webp)|video\/(mp4|quicktime|webm)|audio\/(aac|mp4|mpeg|ogg|wav|webm)|font\/(woff2?|ttf|otf)|application\/pdf)$/,
    'Unsupported media type.'
  )

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, 'SHA-256 must be hexadecimal.')
/** A workspace asset's id, shared with the campaign publish-draft handoff. */
export const assetIdSchema = z.string().uuid()

export const assetCompleteSchema = z.object({
  assetId: assetIdSchema,
  sha256: sha256Schema.optional(),
})

/** Completing a file sent in parts: each part's SHA-256, as the browser read it. */
export const assetPartsCompleteSchema = assetCompleteSchema.extend({
  partSha256: z.array(sha256Schema).max(10_000).optional(),
})

/** The parts of a multipart upload to sign, at most 20 at a time; none asks only what is stored. */
export const assetUploadPartsSchema = z.object({
  assetId: assetIdSchema,
  parts: z.array(z.number().int().min(1).max(10_000)).max(20),
})

export const assetListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  classification: z.enum(assetClassifications).optional(),
  /** Opaque, versioned keyset boundary returned by the previous page. */
  cursor: z
    .string()
    .max(512)
    .regex(/^v1\.[A-Za-z0-9_-]+$/)
    .optional(),
  type: z.enum(['all', 'image', 'video']).default('all'),
  sort: z.enum(['newest', 'oldest']).default('newest'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export const assetDownloadQuerySchema = z.object({
  assetId: assetIdSchema,
})

export const assetUploadSchema = z
  .object({
    bytes: z.number().int().positive().max(MEDIA_LIMITS.videoBytes),
    projectId: z.string().cuid().optional(),
    parentAssetId: assetIdSchema.optional(),
    // Listing never filters on 'poster': a poster only appears on its video.
    classification: z.enum([...assetClassifications, 'poster']).default('input'),
    contentType: contentTypeSchema,
    fileName: z.string().trim().min(1).max(128),
    sha256: sha256Schema.optional(),
  })
  .refine((input) => input.bytes <= uploadByteLimit(input.contentType), {
    message: 'Images are up to 20 MB; videos 512 MiB; PDFs 100 MB.',
    path: ['bytes'],
  })

const hexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-f]{6}$/i, 'Use a #RRGGBB hex color.')

/** Brand fonts are editor catalog ids, never URLs or family names (RFC 019). */
const brandFontSchema = z.enum(fontFamilies.map((font) => font.id))

/** Image types a brand logo may be uploaded as. */
export const brandLogoContentTypeSchema = z.enum(['image/png', 'image/webp', 'image/jpeg'])

/** Largest brand logo upload, in bytes (RFC 019 asset processing). */
export const BRAND_LOGO_MAX_BYTES = 5 * 1024 * 1024

/**
 * A brand kit definition, schema version 1. Field names match the Go
 * validator. Legacy `colors.foreground` is accepted and saved as `text`.
 */
export const brandKitDefinitionSchema = z.object({
  colors: z.preprocess(
    (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value
      const { foreground, ...colors } = value as Record<string, unknown>
      return { text: foreground, ...colors }
    },
    z.object({ accent: hexColorSchema, background: hexColorSchema, text: hexColorSchema })
  ),
  /** The editor's extensions: more colours and logos, Google Fonts, background and frame defaults. */
  editor: brandKitEditorSchema.optional(),
  logo: z.object({ primaryAssetId: assetIdSchema }).optional(),
  schemaVersion: z.literal(1).default(1),
  typography: z.object({
    bodyFamily: brandFontSchema.optional(),
    headingFamily: brandFontSchema,
  }),
})

export const brandKitCreateSchema = z.object({
  definition: brandKitDefinitionSchema,
  name: z.string().trim().min(1).max(100),
  publish: z.boolean().default(false),
})

/** How a prohibited term matches: `word` between word boundaries, `phrase` anywhere. */
export const prohibitedTermMatchModeSchema = z.enum(['word', 'phrase'])

/** A prohibited term: an object with the reason shown on a block, or a legacy bare string. */
export const prohibitedTermInputSchema = z.union([
  z.string().trim().min(1).max(100),
  z.object({
    matchMode: prohibitedTermMatchModeSchema.default('word'),
    reason: z.string().trim().max(300).optional(),
    term: z.string().trim().min(1).max(100),
  }),
])

export const brandProfileUpsertSchema = z.object({
  audience: z.string().trim().min(1).max(1_000),
  ctaConventions: z.string().trim().max(1_000).optional(),
  preferredStyles: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  productDescription: z.string().trim().min(1).max(2_000),
  prohibitedTerms: z.array(prohibitedTermInputSchema).max(200).default([]),
  socialHandles: z.record(z.string(), z.string().trim().max(160)).default({}),
  tagline: z.string().trim().max(200).optional(),
  tone: z.string().trim().min(1).max(500),
})

const channelSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]+$/)
  .max(64)

/** Absolute http(s) URL. Rejects javascript:, data:, and other schemes. */
const webUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2_000)
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'Use an http(s) URL.')

/**
 * Plain-text prose. Release briefs are rendered as text, never as HTML, and
 * markup is rejected here so no stored value depends on output escaping alone.
 */
const plainTextSchema = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !/<\/?[a-z!][^>]*>/i.test(value), 'Use plain text without HTML tags.')
    .refine((value) => !value.includes('\0'), 'Remove null characters.')

export const productEnvironments = ['production', 'staging', 'demo', 'development'] as const

const productSurfaceFields = {
  description: z.string().trim().max(1_000),
  environment: z.enum(productEnvironments),
  featureTags: z.array(z.string().trim().min(1).max(100)).max(50),
  name: z.string().trim().min(1).max(160),
  screenshotAssetIds: z.array(z.string().uuid()).max(50),
  url: webUrlSchema,
}

export const productSurfaceCreateSchema = z.object({
  ...productSurfaceFields,
  description: productSurfaceFields.description.optional(),
  environment: productSurfaceFields.environment.default('production'),
  featureTags: productSurfaceFields.featureTags.default([]),
  screenshotAssetIds: productSurfaceFields.screenshotAssetIds.default([]),
})

// Built from the undefaulted fields: a partial of the create schema would
// apply its defaults and reset omitted arrays and the environment on update.
export const productSurfaceUpdateSchema = z.object(productSurfaceFields).partial()

export const campaignCreateSchema = z.object({
  angles: z
    .array(
      z.object({
        hook: z.string().trim().min(1).max(1_000),
        title: z.string().trim().min(1).max(200),
      })
    )
    .max(20)
    .default([]),
  audience: z.string().trim().max(1_000).optional(),
  feature: z.string().trim().max(500).optional(),
  messaging: z.string().trim().max(2_000).optional(),
  name: z.string().trim().min(1).max(160),
  objective: z.string().trim().min(1).max(500),
  productSurfaceId: z.string().cuid().optional(),
  releaseId: z.string().uuid().optional(),
  posts: z
    .array(
      z.object({
        angleIndex: z.number().int().min(0).optional(),
        callToAction: z.string().trim().max(300).optional(),
        channel: channelSlugSchema,
        copy: z.string().trim().min(1).max(10_000),
      })
    )
    .max(50)
    .default([]),
})

export const campaignApprovalSchema = z
  .object({
    decision: z.enum(['submit', 'approve', 'reject', 'request_changes']),
    /** Why, when rejecting or requesting changes; it guides the next generation. */
    note: z.string().trim().max(1_000).optional(),
    postIds: z.array(z.string().cuid()).min(1).max(100).optional(),
  })
  .refine((input) => input.decision !== 'request_changes' || Boolean(input.note?.trim()), {
    path: ['note'],
    message: 'Explain what should change.',
  })

export const campaignTransitionSchema = z.object({
  campaignId: z.string().cuid(),
  status: z.enum(['DRAFT', 'READY_FOR_REVIEW', 'APPROVED', 'ARCHIVED']),
})

export const campaignPostScheduleSchema = z.object({
  channelConnectionId: z.string().cuid(),
  /** The approved visual to publish with the post. */
  creativeVariantId: z.string().cuid().optional(),
  scheduledAt: z.coerce
    .date()
    .refine((value) => value.getTime() > Date.now(), {
      message: 'Scheduled time must be in the future.',
    })
    .optional(),
  /** Schedule even though a link in the post would preview badly. */
  skipLinkCheck: z.boolean().default(false),
})

/**
 * A hand edit to a post. `expectedCopy` is the copy the edit was made
 * against; the backend refuses the edit if the post changed since. An empty
 * call to action or title clears it.
 */
export const campaignPostUpdateSchema = z.object({
  callToAction: z.string().max(300).optional(),
  copy: z
    .string()
    .max(10_000)
    .refine((value) => value.trim() !== '', 'The post needs copy.')
    .optional(),
  expectedCopy: z.string().max(10_000),
  title: z.string().max(200).optional(),
})

const releaseFields = {
  audience: plainTextSchema(1_000),
  benefitStatement: z.string().trim().min(1).max(500),
  description: plainTextSchema(10_000),
  productSurfaceId: z.string().cuid(),
  sourceUrls: z.array(webUrlSchema).max(20),
  title: z.string().trim().min(1, 'Enter a release title.').max(160),
}

export const releaseCreateSchema = z.object({
  ...releaseFields,
  audience: releaseFields.audience.optional(),
  // Optional when a source link is given (checked in createRelease): the spec
  // drafter reads why it matters from the sources.
  benefitStatement: z.string().trim().max(500).default(''),
  description: releaseFields.description.optional(),
  productSurfaceId: releaseFields.productSurfaceId.optional(),
  sourceUrls: releaseFields.sourceUrls.optional(),
})

/** Edits the brief only; linked campaigns and generated artifacts are untouched. */
export const releaseUpdateSchema = z
  .object({
    ...releaseFields,
    audience: releaseFields.audience.nullable(),
    // May be cleared while a source link remains (checked in updateRelease).
    benefitStatement: z.string().trim().max(500),
    description: releaseFields.description.nullable(),
    productSurfaceId: releaseFields.productSurfaceId.nullable(),
  })
  .partial()

export const releaseListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

/** Source providers whose webhooks have their own conventions; any other slug is generic. */
export const sourceProviderSchema = z.enum(['github', 'gitlab'])

/**
 * The branch whose merges become releases, as GitHub reports it in
 * `pull_request.base.ref`. A full ref or a character Git forbids could never
 * match a delivery, so it is refused rather than silently matching nothing.
 */
export const sourceBranchSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^(?!refs\/)[^\s~^:?*[\\]+$/, 'Use a branch name such as main, not a ref.')

/** A GitHub login, or an App bot login such as `dependabot[bot]`. */
export const pullRequestAuthorSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?$/, 'Use a GitHub login such as octocat.')

/**
 * The rules that decide which deliveries become releases. Omitted on create,
 * a source follows the default branch, ignores bot-authored pull requests,
 * and keeps pre-releases.
 */
const sourceRuleFields = {
  branch: sourceBranchSchema,
  /** Ignore pull requests opened by a GitHub App bot (Dependabot, Renovate). */
  ignoreBotPullRequests: z.boolean(),
  /** Further pull request authors to ignore, matched case-insensitively. */
  ignoredPullRequestAuthors: z.array(pullRequestAuthorSchema).max(100),
  /** Skip GitHub releases marked as pre-releases. */
  skipPrereleases: z.boolean(),
}

export const sourceAppCreateSchema = z
  .object({
    allowedHosts: z.array(z.string().url()).min(1).max(50),
    branch: sourceRuleFields.branch.optional(),
    externalId: z.string().trim().min(1).max(160).optional(),
    // The workspace's GitHub App connection that delivers this repository's events.
    githubConnectionId: z
      .string()
      .regex(/^[a-z0-9]{10,32}$/)
      .optional(),
    ignoreBotPullRequests: sourceRuleFields.ignoreBotPullRequests.optional(),
    ignoredPullRequestAuthors: sourceRuleFields.ignoredPullRequestAuthors.optional(),
    name: z.string().trim().min(1).max(100),
    provider: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_-]+$/)
      .max(64)
      .default('generic'),
    secretReference: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,127}$/)
      .optional(),
    skipPrereleases: sourceRuleFields.skipPrereleases.optional(),
  })
  // Deliveries are matched on the immutable repository ID; a name never matches.
  .refine(
    (input) =>
      input.provider !== sourceProviderSchema.enum.github ||
      input.externalId === undefined ||
      /^\d+$/.test(input.externalId),
    { message: 'A GitHub externalId is the numeric repository ID.', path: ['externalId'] }
  )
  // A connected repository is named by ID, signed by the App, and needs no secret.
  .refine(
    (input) =>
      input.githubConnectionId === undefined ||
      (input.provider === sourceProviderSchema.enum.github &&
        input.externalId !== undefined &&
        input.secretReference === undefined),
    {
      message: 'A connected GitHub source names a repository ID and no secret.',
      path: ['githubConnectionId'],
    }
  )

/**
 * Where a source's provider sends deliveries and the secret to sign them with.
 * The secret is shown once, when the source is created, and is `null` when an
 * operator manages it, for GitLab (which generates its own), or when the
 * server has no signing key.
 */
export const sourceWebhookSetupSchema = z.object({
  secret: z.string().nullable(),
  url: z.string().url(),
})

/** One of {@link sourceWebhookSetupSchema}. */
export type SourceWebhookSetup = z.infer<typeof sourceWebhookSetupSchema>

/** Changes a source's rules; a `null` branch returns it to the repository default. */
export const sourceAppUpdateSchema = z
  .object({ ...sourceRuleFields, branch: sourceRuleFields.branch.nullable() })
  .partial()
  .refine(
    (input) => Object.values(input).some((value) => value !== undefined),
    'Change at least one rule.'
  )

const socialSecretReferenceSchema = z
  .string()
  .regex(/^SOCIAL_(?:API_KEY|OAUTH_TOKEN)(?:_[A-Z0-9_]+)?$/)

const providerSettingsSchema = z.record(z.string(), z.json()).default({})

export const channelConnectionCreateSchema = z.object({
  externalAccountId: z.string().trim().min(1).max(160),
  platform: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]+$/)
    .max(64)
    .default('x'),
  providerSettings: providerSettingsSchema,
  secretReference: socialSecretReferenceSchema.default('SOCIAL_API_KEY'),
})

export const scheduledPostCreateSchema = z.object({
  caption: z.string().trim().min(1).max(3_000),
  channelConnectionId: z.string().cuid(),
  scheduledFor: z.coerce.date().refine((value) => value.getTime() > Date.now(), {
    message: 'Scheduled time must be in the future.',
  }),
  // Exactly one source (RFC 013); check with hasOneScheduledPostSource.
  contentDraftId: z.string().cuid().optional(),
  variantId: z.string().cuid().optional(),
})

/** A scheduled post links to a campaign variant or a content draft, never both. */
export function hasOneScheduledPostSource(input: {
  contentDraftId?: string
  variantId?: string
}): boolean {
  return Boolean(input.contentDraftId) !== Boolean(input.variantId)
}

export const scheduledPostListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

const cuidSchema = z.string().cuid()

export const creativeTemplateCreateSchema = z.object({
  definition: z.record(z.string(), z.json()),
  name: z.string().trim().min(1).max(100),
})

/** Rename a preset or brand kit (every version of its name). */
export const libraryRenameSchema = z.object({
  id: z.string().cuid(),
  name: z.string().trim().min(1).max(100),
})

/** Archive a preset or brand kit (every version of its name). */
export const libraryArchiveSchema = z.object({ id: z.string().cuid() })

export const creativeVariantCreateSchema = z.object({
  aspectRatio: z
    .string()
    .trim()
    .regex(/^\d+:\d+$/)
    .max(16),
  brandKitId: cuidSchema,
  releaseId: z.string().uuid(),
  sourceAssetId: assetIdSchema,
  templateId: cuidSchema,
})

export const creativeVariantApprovalSchema = z.object({
  reason: z.string().trim().max(500).optional(),
  status: z.enum(['APPROVED', 'REJECTED']),
})

/**
 * Schedule a release announcement.
 *
 * `scheduledFor` is optional and defaults to immediate dispatch, since
 * announcing on approval is the common case. When supplied it must be in
 * the future: a past time would be picked up by the very next dispatch
 * tick, which silently turns "schedule" into "send now".
 */
export const announcementScheduleSchema = z.object({
  ctaUrl: z.string().url().max(2_000).optional(),
  releaseDocumentId: z.string().cuid(),
  scheduledFor: z.coerce
    .date()
    .refine((value) => value.getTime() > Date.now(), {
      message: 'Scheduled time must be in the future.',
    })
    .optional(),
})

export const announcementListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

/**
 * Add customers to an announcement audience.
 *
 * Addresses are lowercased so consent cannot be bypassed by varying case:
 * without it, `Customer@example.com` would create a second subscriber row
 * that an unsubscribe on `customer@example.com` would not suppress.
 */
export const audienceSubscriberCreateSchema = z.object({
  subscribers: z
    .array(
      z.object({
        email: z.string().trim().toLowerCase().email().max(320),
        name: z.string().trim().max(200).optional(),
      })
    )
    .min(1)
    .max(1_000),
})

export const audienceListQuerySchema = z.object({
  includeUnsubscribed: z.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})

export type AssetListQuery = z.infer<typeof assetListQuerySchema>
export type AssetUploadInput = z.infer<typeof assetUploadSchema>
export type AnnouncementScheduleInput = z.infer<typeof announcementScheduleSchema>
export type AudienceSubscriberCreateInput = z.infer<typeof audienceSubscriberCreateSchema>
export type BrandKitCreateInput = z.infer<typeof brandKitCreateSchema>
export type BrandProfileUpsertInput = z.infer<typeof brandProfileUpsertSchema>
export type CampaignApprovalInput = z.infer<typeof campaignApprovalSchema>
export type CampaignCreateInput = z.infer<typeof campaignCreateSchema>
export type CampaignPostScheduleInput = z.infer<typeof campaignPostScheduleSchema>
/** A hand edit to a post's copy, call to action, or title. */
export type CampaignPostUpdateInput = z.infer<typeof campaignPostUpdateSchema>
/** How a prohibited term matches. */
export type ProhibitedTermMatchMode = z.infer<typeof prohibitedTermMatchModeSchema>
export type CampaignTransitionInput = z.infer<typeof campaignTransitionSchema>
export type ProductSurfaceCreateInput = z.infer<typeof productSurfaceCreateSchema>
export type ProductSurfaceUpdateInput = z.infer<typeof productSurfaceUpdateSchema>
export type ChannelConnectionCreateInput = z.infer<typeof channelConnectionCreateSchema>
export type CreativeTemplateCreateInput = z.infer<typeof creativeTemplateCreateSchema>
export type CreativeVariantApprovalInput = z.infer<typeof creativeVariantApprovalSchema>
export type CreativeVariantCreateInput = z.infer<typeof creativeVariantCreateSchema>
export type ReleaseCreateInput = z.infer<typeof releaseCreateSchema>
export type ReleaseUpdateInput = z.infer<typeof releaseUpdateSchema>
export type ScheduledPostCreateInput = z.infer<typeof scheduledPostCreateSchema>
export type SourceAppCreateInput = z.infer<typeof sourceAppCreateSchema>
export type SourceAppUpdateInput = z.infer<typeof sourceAppUpdateSchema>
