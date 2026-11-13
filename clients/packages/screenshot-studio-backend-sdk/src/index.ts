import type { YouTubeOptions, TikTokOptions, PublicationReceipt } from './video-publishing.ts'
export {
  publicationReceiptSchema,
  youtubeOptionsSchema,
  tiktokOptionsSchema,
  tiktokCreatorSchema,
  instagramOptionsSchema,
  instagramUsernameSchema,
} from './video-publishing.ts'
export type { YouTubeOptions, TikTokOptions, InstagramOptions } from './video-publishing.ts'
import { z } from 'zod'
import {
  founderHubProfileSchema,
  founderHubAuthorizationSchema,
  founderHubSessionSchema,
  founderHubSettingsSchema,
  founderHubSettingsProfileSchema,
  founderHubSettingsUpdateSchema,
} from './founder-hub.ts'
export * from './founder-hub.ts'
import { founderHubTemplateSchema, founderHubTemplateQuerySchema, founderHubTemplatePageSchema, founderHubTemplateUpdateSchema } from './founder-hub-templates.ts'
export * from './founder-hub-templates.ts'
import { founderHubResourceActionSchema, founderHubResourceResultSchema, founderHubShareWorkspaceSchema } from './founder-hub-resources.ts'
export * from './founder-hub-resources.ts'
import { founderHubReferralSummarySchema, founderHubReferralClaimSchema, founderHubReferralClaimResultSchema } from './founder-hub-referrals.ts'
export * from './founder-hub-referrals.ts'
import { founderHubCRMProvidersSchema, founderHubCRMConnectionsSchema, founderHubCRMConnectInputSchema, founderHubCRMConnectSessionSchema, founderHubCRMDisconnectResultSchema, founderHubCRMRegisterInputSchema, founderHubCRMRegisterResultSchema } from './founder-hub-crm.ts'
export * from './founder-hub-crm.ts'
import {
  founderHubDeviceSchema,
  founderHubDeviceReportInputSchema,
  founderHubDeviceCommandInputSchema,
  founderHubDeviceCommandSchema,
  founderHubDeviceCommandResultSchema,
} from './founder-hub-devices.ts'
export * from './founder-hub-devices.ts'
import {
  frontendSourceSchema,
  frontendEvidenceSchema,
  frontendDecisionSchema,
  frontendPreviewSchema,
  type FrontendSourceInput,
} from './frontend-deployments.ts'
export * from './frontend-deployments.ts'
import {
  githubProductionStateSchema,
  githubPolicyVersionSchema,
  githubProductionDecisionSchema,
  githubProductionCatalogSchema,
  githubRecoverySchema,
  type saveGitHubProductionSchema,
  type previewGitHubProductionSchema,
} from './github-production.ts'
export * from './github-production.ts'
import { socialObservationSchema } from './social-analytics.ts'
export * from './social-analytics.ts'
import {
  workspaceMemberSchema,
  workspaceMembersSchema,
  workspaceMemberRemovalSchema,
  workspaceMemberLeaveSchema,
} from './membership.ts'
export * from './membership.ts'
import {
  recipientInvitationSchema,
  invitationResponseSchema,
  workspaceInvitationDetailSchema,
} from './invitations.ts'
export * from './invitations.ts'
import { draftCommentInputSchema, type DraftCommentInput } from './draft-comments.ts'
export * from './draft-comments.ts'
import { connectionAvailabilitySchema } from './social-availability.ts'
import {
  workspaceCreationInputSchema,
  workspaceCreationResultSchema,
  type WorkspaceCreationInput,
} from './workspace-creation.ts'
export * from './workspace-creation.ts'
export * from './workspace-names.ts'
export * from './social-availability.ts'
import {
  socialOAuthBeginRequestSchema,
  socialOAuthBeginResponseSchema,
  socialOAuthContextSchema,
  socialOAuthExchangeSchema,
} from './social-oauth.ts'
import {
  blueskyConnectionBeginSchema,
  blueskyConnectionBeginResponseSchema,
  blueskyConnectionCompleteSchema,
  blueskyConnectionCompleteResponseSchema,
} from './bluesky-connections.ts'
import type { BlueskyConnectionBegin, BlueskyConnectionComplete } from './bluesky-connections.ts'
export * from './bluesky-connections.ts'
import { mastodonInstanceSchema, socialInstanceQuerySchema } from './social-instances.ts'
export * from './social-instances.ts'
import type { OAuthProvider, SocialOAuthStartOptions } from './social-oauth.js'
export * from './social-oauth.ts'
import type {
  NotificationView,
  NotificationStateInput,
  NotificationStateResult,
} from './notification-state.js'
export * from './notification-state.ts'
import type {
  NotificationSettings,
  NotificationPolicy,
  NotificationPreferences,
  NotificationPage,
  NotificationSeen,
  NotificationConnection,
  NotificationSlackChannels,
  NotificationDelivery,
} from './notifications.js'
export type * from './notifications.js'
/** Typed client for the Screenshot Studio Go backend. Instantiate on a trusted server. */
import type {
  AutomationOverview,
  SaveAutomationInput,
  AutomationDefinition,
  AutomationGraph,
  AutomationEventSnapshot,
  AutomationPreview,
  AutomationHistoryItem,
  AutomationRunSummary,
  AutomationRunDetail,
  AutomationVersion,
  AutomationHistoryFilter,
} from './release-automation.js'
export type * from './release-automation.js'
import type {
  CaptureConnection,
  CaptureConnectionInput,
  CaptureConnectStart,
  CaptureJob,
  CaptureOverview,
  CaptureRecipe,
  CaptureRecipeInput,
} from './capture.js'
export type * from './capture.js'
import type {
  AccountDeletionStatus,
  CopyableSocialSet,
  Engagement,
  ExperimentState,
  PublicProfile,
  SocialAccountHealth,
  SocialSet,
  SocialSetInput,
  SocialSetList,
  SocialSetRemoval,
  SocialSetUpdate,
  StyleGuide,
  UserPreferences,
  UserPreferencesUpdate,
  Webhook,
  WebhookDelivery,
  WebhookWithSecret,
  WritingContext,
  WritingSample,
} from './settings-platform.js'
export type * from './settings-platform.js'
export { socialAccountHealthSchema, socialAccountSchema } from './settings-platform.ts'

/**
 * Who the web facade acts for. The backend rechecks the principal on every
 * request: a session's membership and role, an API key's validity, a support
 * grant's expiry, or a service caller's workspace.
 */
export type BackendScope = { organizationId: string; requestId: string } & (
  | {
      /** The OAuth client a delegated session acts through; the backend checks its live grant. */
      client?: string
      display?: string
      kind?: 'session'
      sessionId: string
      userId: string
    }
  | { display: string; keyId: string; kind: 'api_key' }
  | { grantId: string; kind: 'support'; userId: string }
  | { display: string; kind: 'service' | 'webhook' }
)

export type AuthStoreWhere = {
  connector?: 'AND' | 'OR'
  field: string
  mode?: 'sensitive' | 'insensitive'
  operator?: string
  value: unknown
}

export type AuthStoreRequest = {
  actorSessionId?: string
  data?: Record<string, unknown>
  increment?: Record<string, number>
  limit?: number
  model: string
  offset?: number
  op:
    | 'count'
    | 'consumeOne'
    | 'create'
    | 'delete'
    | 'deleteMany'
    | 'findMany'
    | 'findOne'
    | 'incrementOne'
    | 'update'
    | 'updateMany'
  select?: string[]
  sortBy?: { direction: 'asc' | 'desc'; field: string }
  where?: AuthStoreWhere[]
}

export type AuthStoreResult = {
  count?: number
  row: Record<string, unknown> | null
  rows?: Record<string, unknown>[]
}

export type BackendAuthEvent = {
  action: string
  actorDisplay?: string
  actorUserId?: string
  entityId: string
  entityType: string
  metadata?: Record<string, unknown>
  organizationId: string
  removedUserId?: string
  requestId?: string
}

export type BackendAuditEvent = {
  action: string
  entityId?: string
  entityType: string
  ipHash?: string
  metadata?: Record<string, unknown>
  outcome?: 'SUCCEEDED' | 'FAILED' | 'DENIED'
  userAgentSummary?: string
}

function principalHeaders(scope: BackendScope): Record<string, string> {
  switch (scope.kind) {
    case 'api_key':
      return {
        'x-api-key-id': scope.keyId,
        'x-principal-display': scope.display,
        'x-principal-kind': 'api_key',
      }
    case 'support':
      return {
        'x-principal-kind': 'support',
        'x-support-grant-id': scope.grantId,
        'x-user-id': scope.userId,
      }
    case 'service':
    case 'webhook':
      return { 'x-principal-display': scope.display, 'x-principal-kind': scope.kind }
    default:
      return {
        ...(scope.client ? { 'x-principal-client': scope.client } : {}),
        ...(scope.display ? { 'x-principal-display': scope.display } : {}),
        'x-principal-kind': 'session',
        'x-session-id': scope.sessionId,
        'x-user-id': scope.userId,
      }
  }
}

export type ScheduledPost = {
  caption: string
  channelConnection?: {
    externalAccountId: string
    platform: string
    provider: string
  }
  channelConnectionId: string
  createdAt: string
  id: string
  scheduledFor: string
  status: ScheduledPostStatus
  /** A post comes from exactly one source: a campaign variant or a content draft. */
  contentDraftId: string | null
  variantId: string | null
}

export type ScheduledPostStatus =
  'DRAFT' | 'SCHEDULED' | 'PROCESSING' | 'PUBLISHED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN_DELIVERY'

export type ChannelConnection = {
  createdAt: string
  externalAccountId: string
  id: string
  platform: string
  provider: string
  providerSettings: Record<string, unknown>
  status: 'ACTIVE' | 'DISABLED' | 'REVOKED'
  /** The account as its platform shows it, once the social API has named it. */
  avatarUrl?: string | null
  displayName?: string | null
  handle?: string | null
  /** The profile it belongs to; null when it is in none. */
  socialSetId?: string | null
  /** Its verified state, when the product configuration could read it. */
  health?: SocialAccountHealth
  /** Drafts and scheduled posts that removing it would cancel. */
  queuedPosts?: number
  /** When the row last changed, such as a refresh of its profile. */
  updatedAt?: string
}

export type BrandKit = {
  id: string
  organizationId: string
  name: string
  version: number
  definition: Record<string, unknown>
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'
  createdAt: string
  updatedAt: string
}

/**
 * How a prohibited term matches, after NFKC normalization and case folding:
 * `word` only between word boundaries, `phrase` anywhere, even inside a word.
 */
export type ProhibitedTermMatchMode = 'word' | 'phrase'

/** A term the workspace never publishes, and the reason shown when copy is blocked. */
export type ProhibitedTerm = {
  matchMode: ProhibitedTermMatchMode
  reason?: string
  term: string
}

/** A prohibited term as written: a bare string is the legacy form, a word-mode term. */
export type ProhibitedTermInput =
  string | { matchMode?: ProhibitedTermMatchMode; reason?: string; term: string }

/** A prohibited term found in copy the backend refused. */
export type ProhibitedTermMatch = ProhibitedTerm

/**
 * The prohibited terms a refused write used: a 409 whose `code` is
 * `brand_prohibited_terms`. Null for any other error.
 */
export function prohibitedTermMatches(error: unknown): ProhibitedTermMatch[] | null {
  if (
    !(error instanceof BackendSDKError) ||
    error.status !== 409 ||
    error.details.code !== 'brand_prohibited_terms'
  ) {
    return null
  }
  return Array.isArray(error.details.matches)
    ? (error.details.matches as ProhibitedTermMatch[])
    : []
}

export type BrandProfile = {
  id: string
  organizationId: string
  productDescription: string
  audience: string
  tone: string
  tagline: string | null
  ctaConventions: string | null
  prohibitedTerms: ProhibitedTerm[]
  preferredStyles: string[]
  socialHandles: Record<string, string>
  createdAt: string
  updatedAt: string
}

export type SourceApp = {
  id: string
  organizationId: string
  name: string
  provider: string
  externalId: string | null
  branch: string | null
  ignoreBotPullRequests: boolean
  ignoredPullRequestAuthors: string[]
  skipPrereleases: boolean
  secretReference: string | null
  allowedHosts: string[]
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'
  createdAt: string
  updatedAt: string
}

export type ProductSurface = {
  id: string
  organizationId: string
  name: string
  /** Stable and URL-safe, unique per workspace; set from the name at creation. */
  slug: string
  url: string
  environment: 'production' | 'staging' | 'demo' | 'development'
  description: string | null
  featureTags: string[]
  /** The newest capture assets, at most 50; `listSurfaceCaptures` is the record. */
  screenshotAssetIds: string[]
  lastCapturedAt: string | null
  /** Why the newest capture attempt failed, such as `capture_failed`. */
  lastCaptureFailureCode: string | null
  createdAt: string
  updatedAt: string
}

/** Where a surface capture came from. */
export type SurfaceCaptureSource = 'deployment' | 'agent' | 'release' | 'manual'

/** One screenshot of a surface. The current capture has no `supersededAt`. */
export type SurfaceCapture = {
  assetId: string
  capturedAt: string
  id: string
  source: SurfaceCaptureSource
  /** The deployment event, release, or run that produced it. */
  sourceId: string | null
  supersededAt: string | null
  surfaceId: string
}

/** Why a surface matched a feature, strongest first. */
export type SurfaceMatchReason = 'tag' | 'name' | 'token_overlap' | 'fallback'

/**
 * A surface for a feature. Score is 100 for a tag, 90 for a slug or name,
 * 10-70 by token overlap, and 0 for the fallback: the homepage, returned when
 * nothing matched, which a caller should not present as the feature's screen.
 */
export type SurfaceMatch = {
  currentCaptureAssetId: string | null
  reason: SurfaceMatchReason
  score: number
  surface: ProductSurface
}

/** A claim about the product and the page it came from. */
export type ProductProofPoint = { claim: string; sourceUrl?: string }

/** Where a product profile field's value came from. An edited field is locked. */
export type ProductProfileProvenance = {
  /** How sure an automated source was, in [0, 1], when it said. */
  confidence?: number
  editedByUser: boolean
  /** A person, the product's own site, or third-party enrichment, in that precedence. */
  source: 'manual' | 'automated' | 'enrichment'
  updatedAt: string
  url?: string
}

/** A product profile field name. */
export type ProductProfileField =
  | 'name'
  | 'url'
  | 'summary'
  | 'problem'
  | 'audience'
  | 'capabilities'
  | 'proofPoints'
  | 'pricingNote'
  | 'competitors'

/** The workspace's product memory, one per workspace. */
export type ProductProfile = {
  audience: string
  capabilities: string[]
  competitors: string[]
  createdAt: string
  id: string
  name: string
  pricingNote: string
  problem: string
  proofPoints: ProductProofPoint[]
  provenance: Partial<Record<ProductProfileField, ProductProfileProvenance>>
  summary: string
  updatedAt: string
  url: string
}

/**
 * A product profile change: only the fields given change. A manual change
 * (the default) locks each changed field; an automated one skips locked
 * fields. `unlockFields` lets automated changes update those fields again.
 */
export type UpsertProductProfileInput = {
  audience?: string
  capabilities?: string[]
  competitors?: string[]
  name?: string
  pricingNote?: string
  problem?: string
  proofPoints?: ProductProofPoint[]
  source?: 'manual' | 'automated' | 'enrichment'
  /** The page each automated value came from. */
  sourceUrls?: Partial<Record<ProductProfileField, string>>
  summary?: string
  unlockFields?: ProductProfileField[]
  /** Locks fields as they are: a person confirmed them. */
  acceptFields?: ProductProfileField[]
  url?: string
}

/** One kind of buyer in an ideal customer profile. */
export type IdealCustomerPersona = { role: string; seniority?: string; teamSize?: string }

/** An ideal customer profile field name. */
export type IdealCustomerProfileField =
  'personas' | 'pains' | 'jobs' | 'buyingTriggers' | 'objections' | 'channels'

/** Who the workspace sells to, one per workspace, with per-field provenance. */
export type IdealCustomerProfile = {
  buyingTriggers: string[]
  channels: string[]
  createdAt: string
  id: string
  jobs: string[]
  objections: string[]
  pains: string[]
  personas: IdealCustomerPersona[]
  provenance: Partial<Record<IdealCustomerProfileField, ProductProfileProvenance>>
  updatedAt: string
}

/**
 * An ideal customer profile change, with the product profile's rules: a
 * manual change (the default) locks each changed field; an automated one
 * skips locked fields and records each value's page and confidence.
 */
export type UpsertIdealCustomerProfileInput = {
  buyingTriggers?: string[]
  channels?: string[]
  confidence?: Partial<Record<IdealCustomerProfileField, number>>
  jobs?: string[]
  objections?: string[]
  pains?: string[]
  personas?: IdealCustomerPersona[]
  source?: 'manual' | 'automated' | 'enrichment'
  sourceUrls?: Partial<Record<IdealCustomerProfileField, string>>
  unlockFields?: IdealCustomerProfileField[]
  /** Locks fields as they are: a person confirmed them. */
  acceptFields?: IdealCustomerProfileField[]
}

/** An onboarding run's lifecycle state (docs/rfcs/032). */
export type OnboardingRunStatus =
  'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'

/** One onboarding run: its stage, monotonic progress, and the budgets it used. */
export type OnboardingRun = {
  completedAt: string | null
  completedStages: string[]
  createdByUserId: string | null
  deadlineAt: string
  discoveredUrls: string[]
  enrichmentCostMicros: number
  errorCode: string | null
  errorMessage: string | null
  fastPathMs: number
  id: string
  /** What the run's model calls cost the platform, in USD micros; no AI credits are spent. */
  modelCostMicros: number
  pageLimit: number
  pagesDiscovered: number
  pagesProcessed: number
  pagesSkipped: number
  progress: number
  stage: string
  startedAt: string
  status: OnboardingRunStatus
  tokenBudget: number
  tokensUsed: number
  updatedAt: string
  url: string
  workflowId: string
}

/** The fast path's answer: the drafts on screen and the run deepening them. */
export type OnboardingStartResult = {
  created: boolean
  extracted: boolean
  idealCustomerProfile: IdealCustomerProfile | null
  pages: string[]
  productProfile: ProductProfile | null
  reason?: string
  run: OnboardingRun
}

/** One enrichment finding for a run's site, with its provider and confidence. */
export type OnboardingEnrichmentRecord = {
  confidence: number
  costMicros: number
  domain: string
  expiresAt: string
  fetchedAt: string
  field: string
  id: string
  provider: string
  sourceUrl?: string
  value: unknown
}

/**
 * A hand edit to a post, made against `expectedCopy`; other copy is a 409.
 * An empty `callToAction` or `title` clears it.
 */
export type UpdateCampaignPostInput = {
  callToAction?: string
  copy?: string
  expectedCopy: string
  title?: string
}

/**
 * An edited campaign visual on its way to Publish: the exported workspace
 * asset, the generated post its copy came from (which must belong to the
 * same campaign), the caption kept on the campaign's asset board, and the
 * draft to create.
 */
export type CampaignPublishDraftInput = {
  assetId: string
  campaignPostId?: string
  caption?: string
  draft: BackendContentDraftCreate
}

export type CreateProductSurfaceInput = {
  description?: string
  environment: ProductSurface['environment']
  featureTags: string[]
  name: string
  screenshotAssetIds: string[]
  url: string
}

export type UpdateProductSurfaceInput = Partial<CreateProductSurfaceInput>

export type WorkspaceSettings = {
  organizationId: string
  description: string | null
  locale: string
  timeZone: string
  defaultPublishTime: string
  /** The workspace AI agent kill switch; on unless an owner or admin turned it off. */
  aiAgentEnabled: boolean
  createdAt: string
  updatedAt: string
}

export type Workspace = {
  id: string
  createdAt: string
  logo: string | null
  name: string
  slug: string
  workspaceSettings: WorkspaceSettings | null
}

export type BackendBootstrapSnapshot = {
  user: { id: string; name: string | null; email: string }
  organization: { id: string; logo: string | null; name: string; slug: string }
  organizations: ListedWorkspace[]
  role: string
  settings: Pick<WorkspaceSettings, 'locale' | 'timeZone' | 'defaultPublishTime'> | null
  entitlements: { features: Record<string, boolean>; plan: string; status: string }
  capabilities: {
    /** Whether AI agent runs are allowed in this workspace (the kill switch). */
    aiAgent: boolean
    browserAutomation: boolean
    engineeringAgent: boolean
    publishing: boolean
    voiceCapture: boolean
    workflows: boolean
  }
  counters: { approvals: number; attention: number }
}

export type BackendCurrentUser = {
  id: string
  email: string
  image: string | null
  name: string | null
}

export type BackendActiveAccess = {
  deniedPermissions?: string[]
  organizationId: string
  role: string
}

export type BackendSupportGrant = { grantId: string; organizationId: string }

export type BackendAsset = {
  id: string
  objectKey: string
  status: 'PENDING' | 'UPLOADED' | 'FAILED' | 'DELETED'
}

export type BackendAssetListItem = {
  fileName?: string
  /** A stored opening frame of a video, shown instead of downloading it. */
  posterAssetId?: string
  classification?: string
  projectId?: string
  projectName?: string
  uploadedBy?: string
  bytes: number
  createdAt: string
  height: number | null
  id: string
  mediaType: string
  width: number | null
}

export type BackendAssetPage = { assets: BackendAssetListItem[]; nextCursor: string | null }

/** How a large file is sent: `parts` parts of `partBytes` each, the last one shorter. */
export type BackendAssetMultipart = { partBytes: number; parts: number }

/** A multipart upload's stored parts and signed part URLs (valid 15 minutes). */
export type BackendAssetUploadParts = BackendAssetMultipart & {
  uploaded: number[]
  urls: { number: number; url: string }[]
}

export type BackendAssetUploadInput = {
  parentAssetId?: string
  projectId?: string
  bytes: number
  classification?: 'capture' | 'derived' | 'export' | 'input' | 'poster'
  contentType: string
  fileName: string
  sha256?: string
}

export type BackendReleaseSummary = {
  id: string
  productSurfaceId: string | null
  status: 'DRAFT' | 'READY' | 'ARCHIVED' | 'CANCELLED'
  title: string
}

export type BackendReleaseListItem = BackendReleaseSummary & {
  benefitStatement: string
  features?: ReleaseFeature[]
  screenshotAssetIds?: string[]
  createdAt: string
  updatedAt: string
}

export type BackendReleaseDetail = BackendReleaseListItem & {
  audience: string | null
  description: string | null
  notes?: string | null
  productSurface: {
    environment: string
    id: string
    name: string
    url: string
  } | null
  sourceUrls: string[]
}

export type BackendCreateReleaseInput = {
  audience?: string
  benefitStatement: string
  description?: string
  idempotencyKey: string
  productSurfaceId?: string
  sourceUrls?: string[]
  title: string
}

export type BackendUpdateReleaseInput = Partial<{
  audience: string | null
  benefitStatement: string
  description: string | null
  productSurfaceId: string | null
  sourceUrls: string[]
  title: string
}>

export type BackendCampaignStatus = 'DRAFT' | 'READY_FOR_REVIEW' | 'APPROVED' | 'ARCHIVED'

export type BackendCampaignListItem = {
  audience: string | null
  createdAt: string
  createdByUserId: string | null
  feature: string | null
  id: string
  messaging: string | null
  name: string
  objective: string
  organizationId: string
  productSurfaceId: string | null
  release: { id: string; title: string } | null
  releaseId: string | null
  status: BackendCampaignStatus
  updatedAt: string
}

export type BackendCampaignPost = {
  angleId: string | null
  approvedAt: string | null
  approvedByUserId: string | null
  callToAction: string | null
  campaignId: string
  channel: string
  claims: Record<string, unknown>[] | null
  copy: string
  createdAt: string
  creativeVariantId: string | null
  id: string
  organizationId: string
  phase: string | null
  planItemKey: string | null
  planVersion: number | null
  reviewNote: string | null
  scheduledAt: string | null
  scheduledPostId: string | null
  /** Delivery state of `scheduledPostId`; CANCELLED or FAILED can be rescheduled. */
  scheduledPostStatus: ScheduledPost['status'] | null
  specVersion: number | null
  status:
    | 'DRAFT'
    | 'READY_FOR_REVIEW'
    | 'APPROVED'
    | 'REJECTED'
    | 'NEEDS_CHANGES'
    | 'SCHEDULED'
    | 'PUBLISHED'
  title: string | null
  updatedAt: string
}

export type BackendCampaignDetail = Omit<BackendCampaignListItem, 'release'> & {
  angles: {
    campaignId: string
    createdAt: string
    hook: string
    id: string
    organizationId: string
    position: number
    title: string
    updatedAt: string
  }[]
  assets: {
    asset: {
      height: number | null
      id: string
      mediaType: string
      objectKey: string
      width: number | null
    }
    assetId: string
    campaignId: string
    caption: string | null
    createdAt: string
    id: string
    kind: string
    organizationId: string
    planAssetKey: string | null
    planVersion: number | null
    variantLabel: string | null
  }[]
  posts: BackendCampaignPost[]
  productSurface: { environment: string; id: string; name: string; url: string } | null
  release: {
    audience: string | null
    benefitStatement: string
    description: string | null
    id: string
    sourceUrls: string[]
    status: string
    title: string
    updatedAt: string
  } | null
}

export type BackendCreateCampaignInput = {
  angles: { hook: string; title: string }[]
  audience?: string
  feature?: string
  /** A retried create with the same key returns the first campaign. */
  idempotencyKey?: string
  messaging?: string
  name: string
  objective: string
  posts: { angleIndex?: number; callToAction?: string; channel: string; copy: string }[]
  productSurfaceId?: string
  releaseId?: string
}

/** A created campaign; `created` is false when an idempotency key replayed. */
export type BackendCampaignCreation = BackendCampaignDetail & { created: boolean }

/** A campaign post waiting for a reviewer, with the campaign it belongs to. */
export type BackendPendingApproval = {
  campaign: { id: string; name: string; status: BackendCampaignStatus }
  post: BackendCampaignPost
}

/** One page of the review queue, oldest post first. */
export type BackendApprovalPage = {
  items: BackendPendingApproval[]
  nextCursor: string | null
}

/**
 * An OAuth authorization request from an AI agent's client, as the consent
 * page received it, plus the scopes and key lifetime the member chose.
 */
export type BackendAgentAuthorizationRequest = {
  clientId: string
  codeChallenge?: string
  codeChallengeMethod?: string
  expiresInDays?: number
  redirectUri: string
  resource?: string
  scopes: string[]
}

/** What the agent consent page shows: the client and where the code goes. */
export type BackendAgentConsent = {
  clientId: string
  clientName: string
  redirectHost: string
  redirectUri: string
}

export type BackendDesign = {
  /** The newest approved render. It differs from `renderedAssetId` after a re-render. */
  approvedVariant: { id: string; sourceAssetId: string } | null
  campaignId: string | null
  createdAt: string
  createdByUserId: string | null
  critique: Record<string, unknown> | null
  document: Record<string, unknown>
  id: string
  name: string
  organizationId: string
  parentDesignId: string | null
  planAssetKey: string | null
  planVersion: number | null
  renderedAsset: {
    height: number | null
    id: string
    objectKey: string
    width: number | null
  } | null
  renderedAssetId: string | null
  renderKey: string | null
  templateId: string | null
  updatedAt: string
  variantLabel: string | null
}

export type BackendCreateDesignInput = {
  campaignId?: string
  document: unknown
  name: string
  parentDesignId?: string
  planAssetKey?: string
  planVersion?: number
  templateId?: string
  variantLabel?: string
}

/** Where a content draft is in its life. */
export type BackendContentDraftStatus = 'draft' | 'scheduled' | 'archived'

/** A post written by hand in the document editor (RFC 013). */
export type BackendContentDraft = {
  collabGeneration?: number
  assetIds: string[]
  /** Plate JSON: the editor's value, a list of block nodes. */
  body: unknown[]
  channelConnectionIds: string[]
  createdAt: string
  createdByUserId: string | null
  /** Text a channel posts instead of the body's, by channel. */
  channelText: Record<string, string>
  /** Comment threads on the body and their authors, as the editor keeps them. */
  discussions: Record<string, unknown>
  id: string
  organizationId: string
  plainText: string
  status: BackendContentDraftStatus
  title: string
  updatedAt: string
  updatedByUserId: string | null
  /** Every update is based on this; a stale one is refused with 409 and `currentVersion`. */
  calendarVersion: number
  version: number
  /** Review before scheduling; approval holds for `approvedVersion` only. */
  approvedVersion: number | null
  reviewNote: string | null
  reviewStatus: 'none' | 'pending' | 'approved' | 'changes_requested'
  reviewedByUserId: string | null
  /** The read-and-comment link's token, while the link is on. */
  shareToken: string | null
  /** Comments guests left through that link. */
  guestComments: { createdAt: string; name: string; text: string }[]
  /** The draft's live posts (lists only). */
  publishedPosts: number
  attentionAt?: string | null
  lastPublishedAt?: string | null
  /** The campaign an edited campaign visual was published from, if any. */
  campaignId?: string | null
  /** The campaign post whose copy the draft took, when it did. */
  campaignPostId?: string | null
  /** The release the draft was made from, when it was. */
  releaseId?: string | null
  /** The voice transcript revision the draft was made from, if any. */
  sourceVoiceRevisionId?: string | null
  /** Whether the voice note the draft was made from was deleted since. */
  sourceVoiceRemoved?: boolean
  /** Write (RFC 025): an article's title and cover, for an article draft. */
  article: BackendDraftArticle | null
  /** Posts that failed or whose outcome is unknown (lists only). */
  attentionPosts: number
  /** The attention posts whose outcome is unknown (lists only). */
  checkPosts: number
  /** The queued posts that are publishing now (lists only). */
  publishingPosts: number
  kind: BackendDraftKind
  /** When the next scheduled post goes out (lists only). */
  nextPostAt: string | null
  pinnedAt: string | null
  planTimeZone: string | null
  platformVersions: BackendPlatformVersions
  /** Posts waiting to go out (lists only). */
  queuedPosts: number
  /** Internal notes; never part of a post. */
  scratchpad: string
  sourceDraftId: string | null
  /** Tags of the draft's set, by id (an experiment). */
  tagIds: string[]
  target: BackendDraftTarget | null
  /** The draft's social set and what it copied from the set when created (RFC 024). */
  engagement: Engagement
  naturalPostingTime: boolean
  suppressSlackOnPublish?: boolean
  /** A planned time puts the draft on the calendar; nothing publishes from it (an experiment). */
  plannedFor: string | null
  /** The platform the body is written for. */
  primaryPlatform: string | null
  /** Null is the workspace's default set. */
  socialSetId: string | null
}

/** What kind of post a draft is (RFC 025). */
export type BackendDraftKind = 'standard' | 'reply' | 'quote' | 'repurpose' | 'article'

/** The post a reply answers, a quote embeds, or a repurposed draft came from. */
export type BackendDraftTarget = {
  author?: string
  kind?: 'reply' | 'quote' | 'repurpose'
  platform?: string
  remoteId?: string
  sourceDraftId?: string
  sourcePostId?: string
  text?: string
  url?: string
}

/** An X article's title and cover. */
export type BackendDraftArticle = { coverAssetId?: string; title: string }

/** A platform version's settings. */
export type BackendVersionOptions = {
  youtube?: YouTubeOptions
  tiktok?: TikTokOptions
  /** X: follow-ups once the post is live. */
  automation?: BackendAutoActions
  community?: { id: string; name?: string; shareWithFollowers?: boolean }
  document?: { assetId: string; title?: string }
  firstComment?: string
  numbering?: {
    enabled: boolean
    position: 'start' | 'end'
    skipFirst?: number
    skipLast?: number
    style: 'hash' | 'emoji' | 'dot' | 'slash' | 'leading' | 'fraction' | 'of'
  }
  visibility?: 'PUBLIC' | 'CONNECTIONS'
}

/** Each platform's version of a draft beside its primary body. */
export type BackendPlatformVersions = {
  schemaVersion: 1
  versions: {
    body?: unknown[]
    channel: string
    forkedFromVersion?: number
    mode: 'synced' | 'manual'
    options?: BackendVersionOptions
    sourceHash?: string
  }[]
}

/** A set's tag. */
export type BackendDraftTag = {
  color: string
  createdAt: string
  id: string
  name: string
  socialSetId: string
}

/** A set's thread finisher. */
export type BackendDraftFinisher = {
  createdAt: string
  id: string
  name: string
  quoteFirstPost: boolean
  socialSetId: string
  text: string
  updatedAt: string
}

/** A new draft and what the destination could not take. */
export type BackendDraftCopy = { draft: BackendContentDraft; dropped: string[] }

/** One event in a draft's history. */
export type BackendDraftActivity = {
  action: string
  actorName: string | null
  actorType: string
  actorUserId: string | null
  at: string
  entityId: string
  id: string
  metadata: Record<string, unknown>
}

/** A workspace's drafts settings: its queue's weekly slots and approvals. */
export type BackendContentDraftSettings = {
  postingSlots: { time: string; weekday: number }[]
  requireApproval: boolean
  /** Whether the person who last edited a draft may approve it; an older backend omits it. */
  allowSelfApproval?: boolean
  timeZone: string
}

/** A draft post on the calendar or in the queue, with its draft's title. */
export type BackendCalendarPost = BackendContentDraftPost & {
  campaignId?: string | null
  campaignTitle?: string
  draftId: string
  draftTitle: string
  socialSetId: string | null
  version: number
  calendarVersion: number
  tagIds: string[]
}

/** A suggested posting time and why. */
export type BackendBestTime = { at: string; reason: string; score?: number; samplePosts: number }

/** A saved point in a draft's history; `body` only when one is read. */
export type BackendContentDraftRevision = {
  body?: unknown[]
  createdAt: string
  createdByUserId: string | null
  id: string
  plainText: string
  title: string
  version: number
  /** Why the backup was kept: edit, schedule, plan, publish or recovery. */
  reason: string
  article?: BackendDraftArticle
  platformVersions?: BackendPlatformVersions
}

/** What a share link shows a guest. */
export type BackendSharedContentDraft = {
  imageAssetId?: string | null
  published?: boolean
  publishedUrl?: string | null
  body: unknown[]
  guestComments: { createdAt: string; name: string; text: string }[]
  plainText: string
  title: string
  updatedAt: string
}

/**
 * A live post's follow-ups (X): repost and reply at a like count, quote
 * after hours; reposts at set times and their removal (RFC 025).
 */
export type BackendAutoActions = {
  plugAtLikes?: number
  /** What plugAtLikes counts: likes (the default) or reposts. */
  plugMetric?: 'likes' | 'reposts'
  plugText?: string
  quoteAfterHours?: number
  quoteText?: string
  repostAtLikes?: number
  /** Each a duration after publishing, or a time of day some days later. */
  retweets?: BackendRetweetRule[]
  /** Removes each automatic repost this long after it; 0 keeps them. */
  unretweetAfterMinutes?: number
}

/** When to repost: afterMinutes after publishing, or `days` later at `at` in `timeZone`. */
export type BackendRetweetRule = {
  afterMinutes?: number
  at?: string
  days?: number
  timeZone?: string
}

/** An account a post can tag: an X user or a LinkedIn organization (RFC 025). */
export type BackendSocialMention = {
  handle?: string
  image?: string
  kind: 'person' | 'organization'
  label: string
  /** The X username, or a LinkedIn organization URN. */
  providerId: string
}

/** A live post's follow-up and its receipt (RFC 025). */
export type BackendPostAutomation = {
  attempts: number
  dueAt: string
  failureCode: string | null
  key: string
  kind: 'first_comment' | 'retweet' | 'unretweet' | 'plug' | 'repost_at_likes' | 'quote' | 'thumbnail'
  remoteId: string | null
  status: 'pending' | 'done' | 'failed' | 'skipped' | 'cancelled' | 'expired'
  updatedAt: string
}

/** A poll on a post (X): 2 to 4 choices, open 5 minutes to 7 days. */
export type BackendPoll = {
  multiple?: boolean
  durationMinutes: number
  options: string[]
}

/** The fields a draft is created or updated with. */
export type BackendContentDraftFields = {
  article?: BackendDraftArticle
  assetIds?: string[]
  body?: unknown[]
  channelConnectionIds?: string[]
  channelText?: Record<string, string>
  discussions?: Record<string, unknown>
  plainText?: string
  platformVersions?: BackendPlatformVersions
  target?: BackendDraftTarget
  title?: string
}

/** A new draft: without channels it starts with its set's default platforms. */
export type BackendContentDraftCreate = BackendContentDraftFields & {
  importKey?: string
  requestKey?: string
  kind?: BackendDraftKind
  /** The workspace release the draft is made from; the backend checks it exists. */
  releaseId?: string
  scratchpad?: string
  socialSetId?: string
  /** An experiment. */
  tagIds?: string[]
}

export type BackendContentDraftUpdate = BackendContentDraftFields & {
  collabGeneration?: number
  baseVersion: number
  baseCalendarVersion?: number
  status?: Exclude<BackendContentDraftStatus, 'scheduled'>
  naturalPostingTime?: boolean
  /** RFC 3339, or an empty string to clear (an experiment). */
  plannedFor?: string
  primaryPlatform?: string
}

/** A post scheduled from a content draft, with its delivery status. */
export type BackendContentDraftPost = {
  caption: string
  channelConnectionId: string
  createdAt: string
  id: string
  platform: string
  scheduledFor: string
  status: ScheduledPostStatus
  /** Once live: engagement as last read, and the post on its platform. */
  metrics: Record<string, number> | null
  metricsAt: string | null
  url: string | null
  /** A thread: its reply count and how many went out. */
  replies: number
  threadProgress: {
    publication?: PublicationReceipt
    lastReplyId?: string
    posted: number
    total: number
    quotes?: { postId: string; state: string }[]
  }
  /** Its follow-ups once live, each with its receipt (RFC 025). */
  automations?: BackendPostAutomation[]
  /** How the instant was chosen (RFC 024). */
  naturalOffsetSeconds: number | null
  scheduleMode: 'queue' | 'explicit' | null
  scheduleTimeZone: string | null
  slotAt: string | null
  socialSetId: string | null
  /** Why it did not publish (a provider status or a code such as `MEDIA_UNAVAILABLE`), and when its provider confirmed it. */
  failureCode?: string | null
  publishedAt?: string | null
}

/** One channel of a draft schedule and the caption serialized for it. */
export type BackendContentDraftScheduleTarget = {
  /** The post's images in order; the draft's own when omitted. */
  assetIds?: string[]
  caption: string
  channelConnectionId: string
  /** A thread's later posts, posted as replies to the first, each with its settings. */
  replies?: {
    assetIds: string[]
    caption: string
    options?: BackendPublishOptions
    poll?: { durationMinutes: number; options: string[]; multiple?: boolean }
  }[]
  autoActions?: BackendAutoActions
  poll?: BackendPoll
  /** The first post's settings beyond its text (RFC 025). */
  options?: BackendPublishOptions
  /** The live X post a reply draft answers. */
  replyTo?: string
}

/** A post's settings beyond its text, as a scheduled post keeps them (RFC 025). */
export type BackendPublishOptions = {
  youtube?: YouTubeOptions
  tiktok?: TikTokOptions
  photoTagIds?: string[]
  taggedUserIds?: string[]
  articleCoverAssetId?: string
  articleTitle?: string
  linkPreview?: {
    url: string
    title?: string
    description?: string
    image?: string
    removed?: boolean
  }
  articleHtml?: string
  communityId?: string
  documentAssetId?: string
  documentTitle?: string
  firstComment?: string
  madeWithAi?: boolean
  paidPartnership?: boolean
  pollQuestion?: string
  quoteFirstPost?: boolean
  quoteRemoteId?: string
  replySettings?: 'following' | 'mentionedUsers' | 'subscribers' | 'verified'
  shareWithFollowers?: boolean
  visibility?: 'PUBLIC' | 'CONNECTIONS'
}

/** When a schedule goes out (RFC 025); the backend resolves local times. */
export type BackendScheduleTiming = {
  disambiguation?: 'earlier' | 'later'
  localTime?: string
  naturalPostingTime?: boolean
  publishNow?: boolean
  queue?: boolean
  expectedQueueSlot?: string
  scheduledFor?: Date
  timeZone?: string
  /** Schedule these accounts beside the draft's queued posts instead of replacing them. */
  add?: boolean
  /** Schedule a repeat of an account's post within a day after a `duplicate_content` conflict. */
  confirmDuplicate?: boolean
}

/** One attachment of a batch item: an uploaded asset, or a selected file still uploading. */
export type BackendBatchMedia = {
  assetId?: string
  fileName?: string
  bytes?: number
  uploadAssetId?: string
}

/** A 2x2 grid video concept: a headline above four labelled images, with optional music. */
export type BackendBatchGrid = {
  headline: string
  musicAssetId?: string
  slots: { assetId?: string; topic: string }[]
}

/** When a batch item is meant to go out: a local time in a zone, or the queue at a previewed slot. */
export type BackendBatchTiming = {
  mode?: 'time' | 'queue'
  localTime?: string
  timeZone?: string
  disambiguation?: 'earlier' | 'later'
  expectedQueueSlot?: string
}

/** A staged batch item (RFC 042). `importKey` makes a retry idempotent. */
export type BackendContentBatchItemInput = {
  caption: string
  channelConnectionIds: string[]
  importKey: string
  media: BackendBatchMedia[]
  /** A grid video concept; its rendered video becomes the item's media. */
  grid?: BackendBatchGrid
  /** The file or folder name the item came from, as the person knows it. */
  sourceKey?: string
  timing: BackendBatchTiming
}

/** A batch item with its media facts, its draft and that draft's scheduled posts. */
export type BackendContentBatchItem = {
  caption: string
  channelConnectionIds: string[]
  draft: {
    approvedVersion: number | null
    assetIds: string[]
    channelConnectionIds: string[]
    plainText: string
    reviewStatus: string
    status: string
    title: string
    version: number
  } | null
  draftId: string | null
  id: string
  importKey: string
  media: (BackendBatchMedia & {
    durationMs: number | null
    height: number | null
    mediaType?: string
    status: string
    width: number | null
  })[]
  position: number
  posts: BackendContentDraftPost[]
  grid?: BackendBatchGrid
  sourceKey?: string
  timing: BackendBatchTiming
}

/** One pass over a batch: scheduling its items, or rendering its grid concepts. */
export type BackendContentBatchRun = {
  createdAt: string
  id: string
  items: {
    assetId?: string
    draftId?: string
    error?: string
    grid?: BackendBatchGrid
    itemId: string
    postIds?: string[]
    status: 'PENDING' | 'DONE' | 'FAILED' | 'UNCONFIRMED'
  }[]
  kind: 'submit' | 'render'
  status: 'RUNNING' | 'FINISHED' | 'SUPERSEDED'
  updatedAt: string
}

/** A durable batch of separate posts in one social set. */
export type BackendContentBatch = {
  archivedAt: string | null
  createdAt: string
  id: string
  itemCount: number
  items?: BackendContentBatchItem[]
  render?: BackendContentBatchRun
  submission?: BackendContentBatchRun
  socialSetId: string
  timeZone: string
  title: string
  updatedAt: string
}

/** One item and account: whether it can be scheduled now, and what to fix. */
export type BackendBatchValidation = {
  channelConnectionId: string
  error?: string
  itemId: string
  scheduledFor: string | null
  timeZone: string
  valid: boolean
}

export type BackendContentDraftListQuery = {
  /** A draft with a live post to this account, or, with none, meant for it. */
  connectionId?: string
  cursor?: string
  /** From this instant, with `to` exclusive, on a live post's or a plan's time. */
  from?: string
  kind?: BackendDraftKind
  limit?: number
  search?: string
  socialSetId?: string
  sort?: 'updated_desc' | 'updated_asc' | 'created_desc' | 'created_asc'
  status?: BackendContentDraftStatus
  tagId?: string
  to?: string
  view?: 'drafts' | 'posted' | 'failed' | 'archived'
}

/** A cloud project: an editor composition with revision-checked writes. */
export type BackendProject = {
  createdAt: string
  createdByUserId: string | null
  document: Record<string, unknown>
  documentVersion: number
  id: string
  name: string
  organizationId: string
  /** Every document write is based on this; a stale one is refused with 409. */
  revision: number
  updatedAt: string
  updatedByUserId: string | null
}

/** How a project version came to be. */
export type BackendProjectVersionKind = 'autosave' | 'named' | 'restore' | 'duplicate'

/** A snapshot in a project's history; `document` is only on a single version. */
export type BackendProjectVersion = {
  createdAt: string
  createdByName: string | null
  createdByUserId: string | null
  document?: Record<string, unknown>
  id: string
  kind: BackendProjectVersionKind
  name: string | null
  projectId: string
  revision: number
}

/** Filters for a project list; `cursor` comes from the previous page. */
export type BackendProjectListQuery = {
  cursor?: string
  limit?: number
  search?: string
  sort?: 'updated' | 'name'
}

/** What a creativeSet row holds: a Story Set, a canvas workspace of artboards, a store screenshot project or a Code Studio project. Fixed at creation. */
export type BackendCreativeSetKind = 'story-set' | 'canvas' | 'store' | 'code'

/** One file of a code import: whole code, or a unified patch of a change. */
export type BackendCodeImportFile = { name: string; code?: string; patch?: string; status?: string }

/** What a GitHub link holds, for Code Studio (docs/code-studio.md). */
export type BackendCodeImport = {
  kind: 'github-file' | 'github-pull' | 'github-commit' | 'gist'
  url: string
  repo?: string
  ref?: string
  path?: string
  title?: string
  startLine?: number
  files: BackendCodeImportFile[]
}

/** A cloud creativeSet: an editor composition with revision-checked writes. */
export type BackendCreativeSet = {
  archived: boolean
  createdAt: string
  createdByUserId: string | null
  document: Record<string, unknown>
  documentVersion: number
  id: string
  /** A canvas, store or code document names itself (`kind: 'canvas'`, `'store'` or `'code'`); every other document is a Story Set. */
  kind: BackendCreativeSetKind
  name: string
  organizationId: string
  /** Every document write is based on this; a stale one is refused with 409. */
  revision: number
  updatedAt: string
  updatedByUserId: string | null
}

/** How a creativeSet version came to be. */
export type BackendCreativeSetVersionKind = 'autosave' | 'named' | 'restore' | 'duplicate'

/** A snapshot in a creativeSet's history; `document` is only on a single version. */
export type BackendCreativeSetVersion = {
  createdAt: string
  createdByName: string | null
  createdByUserId: string | null
  document?: Record<string, unknown>
  id: string
  kind: BackendCreativeSetVersionKind
  name: string | null
  creativeSetId: string
  revision: number
}

/** Filters for a creativeSet list; `cursor` comes from the previous page. `kind` defaults to Story Sets. */
export type BackendCreativeSetListQuery = {
  archived?: boolean
  cursor?: string
  kind?: BackendCreativeSetKind
  limit?: number
  search?: string
  sort?: 'updated' | 'name'
}

/** Who may open a share link: anyone with it, or members of its workspace. */
export type ShareLinkAccess = 'PUBLIC' | 'WORKSPACE'

/** A published artifact, as its workspace sees it. */
export type BackendShareLink = {
  access: ShareLinkAccess
  altText: string | null
  assetId: string
  createdAt: string
  description: string | null
  expiresAt: string | null
  height: number | null
  id: string
  mediaType: string
  posterAssetId: string | null
  projectId: string | null
  revokedAt: string | null
  title: string
  token: string
  updatedAt: string
  width: number | null
}

/** What a share page may show for a live link. */
export type BackendPublicShareLink = {
  access: ShareLinkAccess
  altText: string | null
  createdAt: string
  description: string | null
  expiresAt: string | null
  height: number | null
  mediaType: string
  organizationId: string
  posterMediaType: string | null
  title: string
  width: number | null
  /** A frozen Code Studio document, for a live code embed. */
  code?: Record<string, unknown> | null
}

/** A provider an integration connects. */
export type IntegrationProvider = 'SLACK' | 'NOTION' | 'FIGMA'

/** A workspace's connection to a provider account, without credentials. */
export type BackendIntegration = {
  createdAt: string
  createdByUserId: string | null
  displayName: string
  externalId: string
  id: string
  provider: IntegrationProvider
  scopes: string[]
  tokenExpiresAt: string | null
  updatedAt: string
}

export type BackendCreativeTemplate = {
  createdAt: string
  definition: Record<string, unknown>
  id: string
  name: string
  status: string
  version: number
}

/** A fixed image to publish: a design render, or a brand kit and template version. */
export type BackendCreativeVariant = {
  aspectRatio: string
  brandKitId: string | null
  brandKitVersion: number | null
  designId: string | null
  id: string
  releaseId: string
  revision: number
  sourceAssetId: string
  status: string
  templateId: string | null
  templateVersion: number | null
}

export type BackendCreativeApproval = {
  createdAt: string
  decidedAt: string | null
  decidedByUserId: string | null
  id: string
  organizationId: string
  reason: string | null
  status: string
  updatedAt: string
  variantId: string
}

export type BackendEntitlementSummary = {
  /** What is left of the workspace's purchased credit packs. */
  creditBalance: number
  features: Record<string, boolean>
  plan: string
  status: string
}

export type BackendFeatureDecision = { allowed: boolean; currentPlan: string; requiredPlan: string }

export type BackendScreenshotCacheEntry = {
  cloudinaryPublicId: string
  cloudinaryUrl: string
  createdAt: string
  url: string
  urlHash: string
}

/** Exactly one selector: exact normalized URLs, or entries created before an ISO time. */
export type BackendScreenshotCacheFilter = { createdBefore: string } | { urls: string[] }

export type BackendRenderAsset = {
  height: number | null
  id: string
  mediaType: string
  objectKey: string
  sha256: string | null
  status: BackendAsset['status']
  updatedAt: string
  width: number | null
}

export type BackendAnnouncement = {
  channel: string
  createdAt: string
  ctaUrl: string | null
  id: string
  scheduledFor: string | null
  status: string
}

export type BackendAnnouncementListItem = BackendAnnouncement & {
  _count: { recipients: number }
  releaseDocument: { release: { id: string; title: string }; revision: number } | null
}

export type BackendScheduleAnnouncementInput = {
  ctaUrl?: string
  idempotencyKey: string
  releaseDocumentId: string
  scheduledFor?: Date
}

export type BackendAudienceSubscriber = {
  createdAt: string
  email: string
  id: string
  name: string | null
  suppressedAt: string | null
  unsubscribedAt: string | null
}

export type BackendAuditDrain = {
  createdAt: string
  enabled: boolean
  endpoint: string
  id: string
  name: string
  provider: 'DATADOG' | 'GENERIC' | 'SPLUNK'
  updatedAt: string
}

/** The signing secret is sealed by the web facade (AES-256-GCM) before it is sent. */
export type BackendAuditDrainInput = {
  encryptedSigningSecret: string
  endpoint: string
  name: string
  provider: BackendAuditDrain['provider']
}

export type BackendAuditRetention = { legalHold: boolean; retentionDays: number }

/** A permission group: permissions subtracted from its members' roles. */
export type BackendPermissionGroup = {
  createdAt: string
  deniedPermissions: string[]
  id: string
  isDefault: boolean
  memberIds: string[]
  name: string
  updatedAt: string
}

export type BackendPermissionGroupInput = Pick<
  BackendPermissionGroup,
  'deniedPermissions' | 'isDefault' | 'name'
>

/** An organization's app branding. An empty field keeps the Shots default. */
export type BackendWhitelabelSettings = {
  accentColor?: string
  brandName?: string
  faviconUrl?: string
  logoUrl?: string
  primaryColor?: string
}

/** Caller fingerprint recorded with an audit-control change. */
export type BackendAuditRequest = { ipHash?: string | null; userAgentSummary?: string | null }

function auditRequestHeaders(audit?: BackendAuditRequest): Record<string, string> {
  return {
    ...(audit?.ipHash ? { 'x-audit-ip-hash': audit.ipHash } : {}),
    ...(audit?.userAgentSummary ? { 'x-audit-user-agent-summary': audit.userAgentSummary } : {}),
  }
}

export type BackendWebhookSource = {
  branch: string | null
  externalId: string | null
  githubInstallationId?: string | null
  id: string
  ignoreBotPullRequests: boolean
  ignoredPullRequestAuthors: string[]
  organizationId: string
  provider: string
  secretReference: string | null
  skipPrereleases: boolean
}

/** The rules a source update may change; a `null` branch follows the repository default. */
export type SourceAppRulesUpdate = {
  branch?: string | null
  ignoreBotPullRequests?: boolean
  ignoredPullRequestAuthors?: string[]
  skipPrereleases?: boolean
}

export type BackendSourceReleaseInput = {
  audience?: string
  benefitStatement: string
  description?: string
  eventId: string
  /** The release notes in full; the backend reads features and linked PRs from them. */
  notes?: string
  repositoryId?: string
  /** owner/repo, to recognise the repository's own PR links in the notes. */
  repositoryName?: string
  sourceAppId: string
  sourceUrls?: string[]
  title: string
}

/** A pull request merged into a source's branch, held for its next release. */
export type BackendSourceChangeInput = {
  authorLogin?: string
  body: string
  eventId: string
  labels: string[]
  mergedAt: string
  number: number
  repositoryId: string
  sourceAppId: string
  title: string
  url: string
}

/** A deployment GitHub reports as live in production. */
export type BackendDeploymentInput = {
  environment: string
  eventId: string
  externalId: string
  sha?: string
  sourceAppId: string
  url?: string
}

/** A workspace's link to an installation of the platform's GitHub App. */
export type GitHubConnection = {
  accountLogin: string
  accountType: string
  createdAt: string
  id: string
  installationId: number
  repositorySelection: string
  status: 'ACTIVE' | 'SUSPENDED' | 'DELETED'
}

/** A repository an installation can read. */
export type GitHubRepository = {
  defaultBranch: string
  fullName: string
  id: number
  private: boolean
}

/** An installation as GitHub's lifecycle events report it. */
export type GitHubInstallationRecord = {
  accountLogin: string
  accountType: string
  repositorySelection: string
  suspended: boolean
}

/** A paid AI credit pack the web facade verified with the billing provider. */
export type BackendCreditGrant = {
  credits: number
  organizationId: string
  provider: string
  /** The provider's id for the purchase; a repeated reference grants nothing. */
  reference: string
}

/** A billing provider event whose HMAC the web facade already verified. */
export type BackendEntitlementSync = {
  eventId: string
  eventType: string
  expectedVersion: number
  externalCustomerId?: string | null
  externalSubscriptionId?: string | null
  featureOverrides: Partial<Record<string, boolean>>
  graceUntil?: Date | null
  organizationId: string
  plan: 'business' | 'enterprise' | 'free' | 'pro'
  provider: string
  status: 'active' | 'cancelled' | 'past_due' | 'suspended' | 'trialing'
  validUntil?: Date | null
}

export type BackendWorkspaceEntitlement = {
  featureOverrides: Record<string, boolean> | null
  graceUntil: string | null
  lastSyncedAt: string | null
  plan: string
  status: string
  validUntil: string | null
  version: number
}

export type BackendLaunchCampaign = {
  id: string
  name: string
  objective: string
  productSurface: { environment: string; id: string; name: string; url: string } | null
  release: {
    audience: string | null
    benefitStatement: string
    createdByUserId: string | null
    description: string | null
    features?: ReleaseFeature[]
    id: string
    notes?: string | null
    sourceUrls: string[]
    title: string
  } | null
}

/** One line of a release, read from its notes or a merged pull request. */
export type ReleaseFeature = {
  author?: string
  kind: 'feature' | 'improvement' | 'fix' | 'internal' | 'other'
  number?: number
  title: string
  url?: string
}

export type BackendLaunchSpec = {
  approvedAt: string | null
  changeSummary: string | null
  content: unknown
  createdAt: string
  id: string
  modelId: string | null
  origin: string
  releaseId: string
  sources: unknown
  status: 'DRAFT' | 'APPROVED' | 'SUPERSEDED'
  version: number
}

export type BackendLaunchPlan = Omit<BackendLaunchSpec, 'releaseId' | 'sources'> & {
  campaignId: string
  specId: string | null
}

export type BackendLaunchRevision = {
  campaignId: string
  comment: string
  createdAt: string
  decidedAt: string | null
  id: string
  modelId: string | null
  proposal: unknown
  status: 'PROPOSED' | 'APPLIED' | 'DISCARDED'
  targetId: string
  targetKey: string | null
  targetType: string
}

export type BackendLaunchRun = {
  campaignId: string
  error: string | null
  finishedAt: string | null
  /** Last time the worker reported it was alive. */
  heartbeatAt: string | null
  id: string
  kind: string
  resultId: string | null
  startedAt: string
  status: 'FAILED' | 'RUNNING' | 'SUCCEEDED'
  summary: string | null
}

/** Every launch run status. Pipeline runs only reach RUNNING, SUCCEEDED, and FAILED. */
export type BackendLaunchRunStatus =
  'BUDGET_EXHAUSTED' | 'CANCELLED' | 'FAILED' | 'RUNNING' | 'SUCCEEDED'

/** An agent or conversation run (RFC 027). It may have no campaign. */
export type BackendAgentRun = Omit<BackendLaunchRun, 'campaignId' | 'kind' | 'status'> & {
  campaignId: string | null
  costCents: number
  kind: 'agent' | 'conversation'
  status: BackendLaunchRunStatus
  stepCount: number
  tokensIn: number
  tokensOut: number
}

/** A step outcome; DENIED is a tool call refused by authorization. */
export type BackendLaunchRunStepStatus = 'DENIED' | 'FAILED' | 'SUCCEEDED'

/** What a tool call does, from its capability record. */
export type BackendToolEffect = 'approval-request' | 'external' | 'read' | 'render' | 'write'

/**
 * One step a worker appends. `index` is the worker's step number: re-sending
 * a recorded index answers 409, so a resumed worker never duplicates a step.
 * Summaries are redacted by the caller; the backend also blanks
 * credential-like keys and caps each at 16 KiB.
 */
export type BackendLaunchRunStepInput = {
  durationMs?: number
  effect?: BackendToolEffect | null
  errorCode?: string | null
  index: number
  inputSummary?: unknown
  kind: 'model' | 'tool'
  outputSummary?: unknown
  status: BackendLaunchRunStepStatus
  tokensIn?: number
  tokensOut?: number
  /** Required for a tool step, absent for a model step. */
  toolName?: string | null
}

/** A persisted step of a run's trace. */
export type BackendLaunchRunStep = {
  createdAt: string
  durationMs: number
  effect: BackendToolEffect | null
  errorCode: string | null
  id: string
  index: number
  inputSummary: unknown
  kind: 'model' | 'tool'
  outputSummary: unknown
  runId: string
  status: BackendLaunchRunStepStatus
  tokensIn: number
  tokensOut: number
  toolName: string | null
}

/** A workspace-visible conversation (RFC 028), without its messages. */
export type BackendConversation = {
  campaignId: string | null
  createdAt: string
  createdByUserId: string | null
  id: string
  status: 'ACTIVE' | 'ARCHIVED'
  title: string
  updatedAt: string
}

export type BackendConversationMessageRole = 'assistant' | 'tool' | 'user'
export type BackendConversationMessageKind = 'clarification' | 'text' | 'tool'

export type BackendConversationMessage = {
  content: string
  conversationId: string
  createdAt: string
  id: string
  kind: BackendConversationMessageKind
  launchRunId: string | null
  metadata: unknown
  role: BackendConversationMessageRole
  toolName: string | null
}

/**
 * A message to append. Any member sends a plain user text message; any
 * other role or kind needs owner, admin, or creator, or the conversation's
 * author citing (`launchRunId`) a conversation run they started. Content is
 * at most 20,000 characters.
 */
export type BackendConversationMessageInput = {
  content: string
  kind: BackendConversationMessageKind
  launchRunId?: string | null
  metadata?: unknown
  role: BackendConversationMessageRole
  toolName?: string | null
}

/** A conversation change for its author or an owner or admin; `campaignId: null` unlinks. */
export type BackendConversationUpdate = {
  campaignId?: string | null
  status?: 'ACTIVE' | 'ARCHIVED'
  title?: string
}

/** A new spec or plan version. Metadata is flat and lands in the audit entry. */
export type BackendLaunchVersionInput = {
  changeSummary: string
  content: unknown
  metadata?: Record<string, boolean | null | number | string>
  modelId?: string | null
  origin: 'ai' | 'human' | 'revision'
}

export type BackendLaunchPostsInput = {
  angles: { hook: string; key: string; title: string }[]
  metadata?: Record<string, boolean | null | number | string>
  planVersion: number
  posts: {
    angleKey: string
    callToAction: string
    channel: string
    claims: Record<string, unknown>[]
    copy: string
    phase: string
    title: string
  }[]
  specVersion: number
}

export type BackendLaunchPreferences = {
  approved: { channel: string; copy: string; title: string | null }[]
  rejected: { channel: string; copy: string; reviewNote: string | null; status: string }[]
  revisions: { comment: string; proposal: unknown; targetType: string }[]
}

/** A campaign asset link with the upload status of its asset. */
export type BackendCampaignAssetLink = BackendCampaignDetail['assets'][number] & {
  assetStatus: 'PENDING' | 'UPLOADED' | 'FAILED' | 'DELETED'
}

/** Linking an asset again replaces its caption and provenance; null clears them. */
export type BackendLinkCampaignAssetInput = {
  caption?: string | null
  kind: string
  planAssetKey?: string | null
  planVersion?: number | null
  variantLabel?: string | null
}

export type BackendGeneratedAssetInput = {
  body: Uint8Array
  classification: 'capture' | 'derived' | 'export' | 'input'
  contentType: 'image/jpeg' | 'image/png' | 'image/webp'
  fileName: string
  height: number
  parentAssetId?: string
  width: number
}

export type BackendGeneratedAsset = { id: string; mediaType: string; objectKey: string }

export type AuditLogQuery = {
  action?: string
  actorUserId?: string
  cursor?: string
  endDate?: Date
  entityType?: string
  limit?: number
  outcome?: 'SUCCEEDED' | 'FAILED' | 'DENIED'
  search?: string
  startDate?: Date
}

export type AuditLogItem = {
  id: string
  organizationId: string
  createdAt: string
  requestId: string
  actorType: 'USER' | 'SERVICE' | 'SUPPORT' | 'WEBHOOK'
  actorUserId: string | null
  actorDisplay: string | null
  action: string
  outcome: 'SUCCEEDED' | 'FAILED' | 'DENIED'
  entityType: string
  entityId: string | null
  ipHash: string | null
  userAgentSummary: string | null
  metadata: Record<string, unknown> | null
  searchText: string
}

export type AuditLogPage = { items: AuditLogItem[]; nextCursor?: string }

export type WorkspaceMutation = {
  organization: Omit<Workspace, 'workspaceSettings'>
  settings: WorkspaceSettings
}

export type ListedWorkspace = {
  id: string
  isScheduledForDeletion: boolean
  name: string
  role: string
  slug: string
  workspaceDeletion?: { requestedByUserId: string; scheduledFor: string; status: string }
}

export type UpdateWorkspaceInput = {
  /** Turns AI agent runs on or off. Owner or admin only; audited. */
  aiAgentEnabled?: boolean
  defaultPublishTime?: string
  description?: string | null
  locale?: string
  logo?: string | null
  name: string
  slug: string
  timeZone?: string
}

export type WorkspaceInvitation = {
  createdAt: string
  email: string
  expiresAt: string
  id: string
  role: string | null
  status: string
}

export type WorkspaceDeletion = {
  id: string
  organizationId: string
  requestedByUserId: string
  status: 'PENDING' | 'PROCESSING' | 'CANCELLED' | 'PURGED'
  scheduledFor: string
  cancelledAt: string | null
  processingAt: string | null
  purgedAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export class BackendSDKError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
    /** The backend's error body, e.g. a quota's limit and reset time. */
    readonly details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'BackendSDKError'
  }
}

/** One rendered slide in a store screenshot review. */
export type BackendStoreReviewSlide = {
  slideId: string
  name: string
  assetId: string
  width: number
  height: number
}

/** A reviewer comment, keyed by the editor's stable slide id. */
export type BackendStoreReviewComment = {
  id: string
  slideId: string
  x: number | null
  y: number | null
  authorName: string
  body: string
  fromLink: boolean
  resolvedAt: string | null
  createdAt: string
}

/** A shareable store screenshot review snapshot. */
export type BackendStoreReview = {
  id: string
  projectId: string
  name: string
  versionLabel: string
  projectRevision: number
  shareTokenId: string
  slides: BackendStoreReviewSlide[]
  revokedAt: string | null
  createdAt: string
  updatedAt: string
  comments: BackendStoreReviewComment[]
}

/** A store publishing credential without its secret. */
export type BackendStorePublishingCredential = {
  id: string
  provider: 'APP_STORE_CONNECT' | 'GOOGLE_PLAY'
  label: string
  metadata: Record<string, string>
  lastUsedAt: string | null
  createdAt: string
}

export class ScreenshotStudioBackendSDK {
  private readonly baseURL: string

  constructor(
    baseURL: string,
    private readonly serviceToken: string,
    private readonly scope: BackendScope,
    private readonly fetcher: typeof fetch = fetch
  ) {
    if (!baseURL || !serviceToken) {
      throw new BackendSDKError('Publishing backend is not configured.', 503)
    }
    this.baseURL = `${baseURL.replace(/\/$/, '')}/`
  }

  private async request<T>(
    path: string,
    init: {
      body?: unknown
      headers?: Record<string, string>
      method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
      rawBody?: BodyInit
      responseType?: 'bytes' | 'response'
    } = {}
  ) {
    let response: Response
    try {
      response = await this.fetcher(new URL(path, this.baseURL), {
        body: init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
        cache: 'no-store',
        headers: {
          authorization: `Bearer ${this.serviceToken}`,
          'content-type': 'application/json',
          'x-organization-id': this.scope.organizationId,
          'x-request-id': this.scope.requestId,
          ...principalHeaders(this.scope),
          ...init.headers,
        },
        method: init.method ?? 'GET',
      })
    } catch {
      throw new BackendSDKError('Publishing backend is unavailable.', 503)
    }
    if (init.responseType === 'response' && response.status === 416) return response as T
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as
        ({ error?: string } & Record<string, unknown>) | null
      const status =
        ([400, 401, 403, 404, 409, 429] as const).find((value) => value === response.status) ?? 503
      throw new BackendSDKError(error?.error ?? 'Publishing request failed.', status, error ?? {})
    }
    return (
      init.responseType === 'response'
        ? response
        : init.responseType === 'bytes'
          ? new Uint8Array(await response.arrayBuffer())
          : await response.json()
    ) as T
  }

  async listScheduledPosts(limit: number) {
    return this.request<{ items: ScheduledPost[] }>(`v1/scheduled-posts?limit=${limit}`)
  }

  /** Schedules one post from exactly one source: `variantId` or `contentDraftId`. */
  async createScheduledPost(
    input: {
      caption: string
      channelConnectionId: string
      idempotencyKey: string
      scheduledFor: Date
    } & (
      { contentDraftId?: never; variantId: string } | { contentDraftId: string; variantId?: never }
    )
  ) {
    return this.request<{ created: boolean; scheduledPost: ScheduledPost }>('v1/scheduled-posts', {
      body: input,
      method: 'POST',
    })
  }

  async cancelScheduledPost(id: string) {
    return this.request<ScheduledPost>(`v1/scheduled-posts/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    })
  }

  async listConnections() {
    return this.request<{ items: ChannelConnection[] }>('v1/channel-connections')
  }

  /** Removes an account from the workspace, in a profile or in none; its queued posts are cancelled. */
  async removeConnection(id: string) {
    return this.request<SocialSetRemoval>(`v1/channel-connections/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  }

  /** Reads an account's name, handle and picture from its platform again, with its current health. */
  async refreshConnection(id: string) {
    return this.request<ChannelConnection>(
      `v1/channel-connections/${encodeURIComponent(id)}/refresh`,
      { method: 'POST' }
    )
  }

  async createConnection(input: {
    externalAccountId: string
    platform: string
    providerSettings: Record<string, unknown>
    secretReference: string
  }) {
    return this.request<ChannelConnection>('v1/channel-connections', {
      body: input,
      method: 'POST',
    })
  }

  /** Read the current workspace-bound configuration readiness without creating an attempt. */
  async socialConnectionAvailability() {
    return connectionAvailabilitySchema.parse(
      await this.request('v1/social-connection-availability')
    )
  }

  /** Read public Mastodon metadata through the backend’s bounded network guard. */
  async previewMastodonInstance(server: string) {
    const query = new URLSearchParams(socialInstanceQuerySchema.parse({ server }))
    return mastodonInstanceSchema.parse(await this.request(`v1/social-instances/mastodon?${query}`))
  }

  /** Begins a provider connection; with a set, the account joins that set (RFC 024). */
  async beginSocialOAuth(
    provider: OAuthProvider,
    socialSetId?: string,
    options: SocialOAuthStartOptions = {}
  ) {
    return socialOAuthBeginResponseSchema.parse(
      await this.request('v1/social-oauth/begin', {
        body: socialOAuthBeginRequestSchema.parse({ provider, socialSetId, ...options }),
        method: 'POST',
      })
    )
  }

  /** Create a session-bound Bluesky attempt without sending credentials. */
  async beginBlueskyConnection(input: BlueskyConnectionBegin) {
    return blueskyConnectionBeginResponseSchema.parse(
      await this.request('v1/social-connections/bluesky/begin', {
        method: 'POST',
        body: blueskyConnectionBeginSchema.parse(input),
      })
    )
  }

  /** Submit credentials once or recover the attempt without resending them. */
  async completeBlueskyConnection(input: BlueskyConnectionComplete) {
    return blueskyConnectionCompleteResponseSchema.parse(
      await this.request('v1/social-connections/bluesky/connect', {
        method: 'POST',
        body: blueskyConnectionCompleteSchema.parse(input),
      })
    )
  }

  /** Resolve a session-bound attempt independently of the selected workspace. */
  async resolveSocialOAuthContext(provider: OAuthProvider, state: string) {
    return socialOAuthContextSchema.parse(
      await this.request('v1/social-oauth/context', {
        body: { provider, state },
        method: 'POST',
      })
    )
  }

  async verifySocialOAuth(provider: OAuthProvider, state: string, integrationId?: string) {
    return this.request('v1/social-oauth/verify', {
      body: { provider, state, integrationId },
      method: 'POST',
    })
  }

  async exchangeSocialOAuth(provider: OAuthProvider, state: string, code: string) {
    return socialOAuthExchangeSchema.parse(
      await this.request('v1/social-oauth/exchange', {
        body: { provider, state, code },
        method: 'POST',
      })
    )
  }

  async selectInstagramOAuthPage(input: {
    provider?: OAuthProvider
    state: string
    integrationId: string
    accountId: string
    pageId: string
  }) {
    return this.request<{ selected: boolean }>('v1/social-oauth/page', {
      body: input,
      method: 'POST',
    })
  }

  async rememberInstagramIntegration(
    state: string,
    integrationId: string,
    provider: OAuthProvider = 'instagram'
  ) {
    return this.request('v1/social-oauth/remember', {
      body: { provider, state, integrationId },
      method: 'POST',
    })
  }

  async completeSocialOAuth(provider: OAuthProvider, state: string, integrationId: string) {
    return this.request('v1/social-oauth/complete', {
      body: { provider, state, integrationId },
      method: 'POST',
    })
  }

  async listBrandKits() {
    return this.request<{ brandKits: BrandKit[] }>('v1/brand-kits')
  }

  async createBrandKit(input: {
    definition: Record<string, unknown>
    name: string
    publish: boolean
  }) {
    return this.request<BrandKit>('v1/brand-kits', { body: input, method: 'POST' })
  }

  /** Rename every version of the brand kit `id` belongs to. */
  async renameBrandKit(id: string, name: string) {
    return this.request<BrandKit>(`v1/brand-kits/${encodeURIComponent(id)}`, {
      body: { name },
      method: 'PATCH',
    })
  }

  /** Archive every version of the brand kit `id` belongs to. */
  async archiveBrandKit(id: string) {
    return this.request<{ archived: true }>(`v1/brand-kits/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  }

  /** Read-only guidance inherited by a member's social sets. */
  async getWritingDefaults() {
    return this.request<{ tone: string; audience: string; prohibitedPhrases: string[] }>(
      'v1/brand-profile?view=writing-defaults'
    )
  }

  async getBrandProfile() {
    return this.request<{ brandProfile: BrandProfile | null }>('v1/brand-profile')
  }

  async upsertBrandProfile(input: {
    audience: string
    ctaConventions?: string
    preferredStyles: string[]
    productDescription: string
    prohibitedTerms: ProhibitedTermInput[]
    socialHandles: Record<string, string>
    tagline?: string
    tone: string
  }) {
    return this.request<BrandProfile>('v1/brand-profile', { body: input, method: 'POST' })
  }

  /** The workspace's product profile, or null before one is saved. */
  async getProductProfile() {
    return this.request<{ productProfile: ProductProfile | null }>('v1/product-profile')
  }

  /** Creates or changes the product profile; owner or admin only. */
  async upsertProductProfile(input: UpsertProductProfileInput) {
    return this.request<ProductProfile>('v1/product-profile', { body: input, method: 'POST' })
  }
  /** The workspace's ideal customer profile, or null before one is saved. */
  async getIdealCustomerProfile() {
    return this.request<{ idealCustomerProfile: IdealCustomerProfile | null }>(
      'v1/ideal-customer-profile'
    )
  }
  /** Creates or changes the ideal customer profile; owner or admin only. */
  async upsertIdealCustomerProfile(input: UpsertIdealCustomerProfileInput) {
    return this.request<IdealCustomerProfile>('v1/ideal-customer-profile', {
      body: input,
      method: 'POST',
    })
  }
  /** Reads the product's site within ten seconds and starts the background run. */
  async startOnboardingRun(input: { idempotencyKey?: string; sentence?: string; url: string }) {
    return this.request<OnboardingStartResult>('v1/onboarding-runs', {
      body: input,
      method: 'POST',
    })
  }
  /** One onboarding run; while it runs, its progress is live. */
  async getOnboardingRun(id: string) {
    return this.request<{ run: OnboardingRun }>(`v1/onboarding-runs/${encodeURIComponent(id)}`)
  }
  /** The workspace's newest onboarding run, or null before its first. */
  async latestOnboardingRun() {
    return this.request<{ run: OnboardingRun | null }>('v1/onboarding-runs/latest')
  }
  /** Stops a running run; it keeps what it already read. */
  async cancelOnboardingRun(id: string) {
    return this.request<{ run: OnboardingRun }>(
      `v1/onboarding-runs/${encodeURIComponent(id)}/cancel`,
      {
        method: 'POST',
      }
    )
  }
  /** Starts a new run for a run's URL; unchanged pages cost nothing. */
  async rerunOnboardingRun(id: string, input: { idempotencyKey?: string } = {}) {
    return this.request<OnboardingStartResult>(
      `v1/onboarding-runs/${encodeURIComponent(id)}/rerun`,
      {
        body: input,
        method: 'POST',
      }
    )
  }
  /** What enrichment found for a run's site. */
  async listOnboardingEnrichment(id: string) {
    return this.request<{ enrichment: OnboardingEnrichmentRecord[] }>(
      `v1/onboarding-runs/${encodeURIComponent(id)}/enrichment`
    )
  }

  async createSourceApp(input: {
    allowedHosts: string[]
    branch?: string
    externalId?: string
    githubConnectionId?: string
    ignoreBotPullRequests?: boolean
    ignoredPullRequestAuthors?: string[]
    name: string
    provider: string
    secretReference?: string
    skipPrereleases?: boolean
  }) {
    return this.request<SourceApp>('v1/source-apps', { body: input, method: 'POST' })
  }

  async updateSourceApp(sourceAppId: string, input: SourceAppRulesUpdate) {
    return this.request<SourceApp>(`v1/source-apps/${encodeURIComponent(sourceAppId)}`, {
      body: input,
      method: 'PATCH',
    })
  }

  async listProductSurfaces() {
    return this.request<{ productSurfaces: ProductSurface[] }>('v1/product-surfaces')
  }

  async createProductSurface(input: CreateProductSurfaceInput) {
    return this.request<ProductSurface>('v1/product-surfaces', { body: input, method: 'POST' })
  }

  async updateProductSurface(id: string, input: UpdateProductSurfaceInput) {
    return this.request<ProductSurface>(`v1/product-surfaces/${encodeURIComponent(id)}`, {
      body: input,
      method: 'PATCH',
    })
  }

  async deleteProductSurface(id: string) {
    return this.request<{ deleted: true }>(`v1/product-surfaces/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  }

  /** Ranks surfaces for a feature with no model involved; see `SurfaceMatch`. */
  async findSurfacesForFeature(input: { feature: string; limit?: number; tags?: string[] }) {
    const query = new URLSearchParams({ feature: input.feature })
    for (const tag of input.tags ?? []) query.append('tag', tag)
    if (input.limit !== undefined) query.set('limit', String(input.limit))
    return this.request<{ matches: SurfaceMatch[] }>(`v1/product-surfaces/match?${query}`)
  }

  /** A surface's 50 newest captures, current first. */
  async listSurfaceCaptures(surfaceId: string) {
    return this.request<{ captures: SurfaceCapture[] }>(
      `v1/product-surfaces/${encodeURIComponent(surfaceId)}/captures`
    )
  }

  /** Makes an uploaded image the surface's current capture, superseding the last. */
  async recordSurfaceCapture(
    surfaceId: string,
    input: {
      assetId: string
      source: Exclude<SurfaceCaptureSource, 'deployment'>
      sourceId?: string
    }
  ) {
    return this.request<SurfaceCapture>(
      `v1/product-surfaces/${encodeURIComponent(surfaceId)}/captures`,
      { body: input, method: 'POST' }
    )
  }

  /** Atomically creates a workspace and its owner, or returns an authorized retry. */
  async createWorkspace(input: WorkspaceCreationInput) {
    return workspaceCreationResultSchema.parse(
      await this.request<unknown>('v1/workspaces', {
        body: workspaceCreationInputSchema.parse(input),
        method: 'POST',
      })
    )
  }

  async listWorkspaces() {
    return this.request<{ workspaces: ListedWorkspace[] }>('v1/workspaces')
  }

  async getCurrentUser() {
    return this.request<{ user: BackendCurrentUser }>('v1/me')
  }

  async getFounderHubSession() {
    return founderHubSessionSchema.parse(await this.request('v1/founder-hub/session'))
  }

  async authorizeFounderHubSession() {
    return founderHubAuthorizationSchema.parse(await this.request('v1/founder-hub/authorization'))
  }

  async getFounderHubSettings() {
    return founderHubSettingsSchema.parse(await this.request('v1/founder-hub/settings'))
  }

  async getFounderHubTemplates(input: z.input<typeof founderHubTemplateQuerySchema>) {
    const query = new URLSearchParams(founderHubTemplateQuerySchema.parse(input))
    return founderHubTemplatePageSchema.parse(await this.request(`v1/founder-hub/templates?${query}`))
  }

  async founderHubResourceAction(input: z.input<typeof founderHubResourceActionSchema>) {
    return founderHubResourceResultSchema.parse(await this.request('v1/founder-hub/resources', {method: 'POST', body: founderHubResourceActionSchema.parse(input)}))
  }

  async founderHubShareWorkspaces() {
    return z.array(founderHubShareWorkspaceSchema).parse(await this.request('v1/founder-hub/resources/workspaces'))
  }

  async getFounderHubReferralSummary() {
    return founderHubReferralSummarySchema.parse(await this.request('v1/founder-hub/referrals'))
  }

  async claimFounderHubReferral(input: z.input<typeof founderHubReferralClaimSchema>) {
    return founderHubReferralClaimResultSchema.parse(await this.request('v1/founder-hub/referrals/claim', {
      method: 'POST',
      body: founderHubReferralClaimSchema.parse(input),
    }))
  }

  async getFounderHubCRMProviders() {
    return founderHubCRMProvidersSchema.parse(await this.request('v1/founder-hub/crm/providers'))
  }

  async getFounderHubCRMConnections() {
    return founderHubCRMConnectionsSchema.parse(await this.request('v1/founder-hub/crm/connections'))
  }

  async createFounderHubCRMConnectSession(input: z.input<typeof founderHubCRMConnectInputSchema>) {
    return founderHubCRMConnectSessionSchema.parse(await this.request('v1/founder-hub/crm/session', {
      method: 'POST',
      body: founderHubCRMConnectInputSchema.parse(input),
    }))
  }

  async registerFounderHubCRMConnection(input: z.input<typeof founderHubCRMRegisterInputSchema>) {
    return founderHubCRMRegisterResultSchema.parse(await this.request('v1/founder-hub/crm/connections', {
      method: 'POST',
      body: founderHubCRMRegisterInputSchema.parse(input),
    }))
  }

  async deleteFounderHubCRMConnection(provider: string, connectionId: string) {
    const query = new URLSearchParams({ provider })
    return founderHubCRMDisconnectResultSchema.parse(await this.request(`v1/founder-hub/crm/connections/${encodeURIComponent(connectionId)}?${query}`, { method: 'DELETE' }))
  }

  async updateFounderHubTemplate(id: string, input: z.input<typeof founderHubTemplateUpdateSchema>, native = false) {
    return founderHubTemplateSchema.parse(await this.request(`v1/founder-hub/templates/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'X-Shots-Founder-Hub-Native': String(native) },
      body: founderHubTemplateUpdateSchema.parse(input),
    }))
  }

  async getFounderHubDevices() {
    return z.array(founderHubDeviceSchema).parse(await this.request('v1/founder-hub/devices'))
  }
  async reportFounderHubDevice(input: z.input<typeof founderHubDeviceReportInputSchema>) {
    return z.array(founderHubDeviceCommandSchema).parse(
      await this.request('v1/founder-hub/devices/report', {
        method: 'POST',
        body: founderHubDeviceReportInputSchema.parse(input),
      })
    )
  }
  async createFounderHubDeviceCommand(input: z.input<typeof founderHubDeviceCommandInputSchema>) {
    return founderHubDeviceCommandSchema.parse(
      await this.request('v1/founder-hub/devices/commands', {
        method: 'POST',
        body: founderHubDeviceCommandInputSchema.parse(input),
      })
    )
  }
  async getFounderHubDeviceCommand(id: string) {
    return founderHubDeviceCommandSchema.parse(
      await this.request(`v1/founder-hub/devices/commands/${encodeURIComponent(id)}`)
    )
  }
  async finishFounderHubDeviceCommand(
    id: string,
    input: z.input<typeof founderHubDeviceCommandResultSchema>
  ) {
    return founderHubDeviceCommandSchema.parse(
      await this.request(`v1/founder-hub/devices/commands/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: founderHubDeviceCommandResultSchema.parse(input),
      })
    )
  }

  async updateFounderHubSettings(
    input: z.input<typeof founderHubSettingsUpdateSchema>,
    native = false
  ) {
    return founderHubSettingsProfileSchema.parse(
      await this.request('v1/founder-hub/settings', {
        method: 'PATCH',
        headers: { 'X-Shots-Founder-Hub-Native': String(native) },
        body: founderHubSettingsUpdateSchema.parse(input),
      })
    )
  }

  async getFounderHubKeySession() {
    return founderHubSessionSchema.parse(await this.request('v1/founder-hub/key-session'))
  }

  async getFounderHubConnectorSession(clientId: string) {
    return founderHubSessionSchema.parse(
      await this.request(`v1/founder-hub/connector-session?${new URLSearchParams({ clientId })}`)
    )
  }

  async getFounderHubProfile(userId: string) {
    return founderHubProfileSchema.parse(
      await this.request(`v1/internal/founder-hub/users/${encodeURIComponent(userId)}`)
    )
  }

  async revokeFounderHubSession() {
    return this.request<{ revoked: true }>('v1/founder-hub/session', { method: 'DELETE' })
  }

  async getActiveAccess() {
    return this.request<BackendActiveAccess>('v1/access')
  }

  async verifySupportGrant(organizationId: string, scope: string) {
    const parameters = new URLSearchParams({ organizationId, scope })
    return this.request<BackendSupportGrant>(`v1/support-grants/verify?${parameters}`)
  }

  async requireEnterpriseFeature(feature: 'ssoEnabled' | 'scimEnabled') {
    return this.request<{ enabled: true }>(`v1/enterprise-features/${feature}`)
  }

  async listAssets(options: {
    search?: string
    classification?: string
    cursor?: string
    limit: number
    type?: 'all' | 'image' | 'video'
    sort?: 'newest' | 'oldest'
  }) {
    const parameters = new URLSearchParams({ limit: String(options.limit) })
    if (options.cursor) parameters.set('cursor', options.cursor)
    if (options.type) parameters.set('type', options.type)
    if (options.sort) parameters.set('sort', options.sort)
    if (options.search) parameters.set('search', options.search)
    if (options.classification) parameters.set('classification', options.classification)
    return this.request<BackendAssetPage>(`v1/assets?${parameters}`)
  }

  async signAssetUpload(input: BackendAssetUploadInput) {
    return this.request<{ asset: BackendAsset; uploadUrl: string }>('v1/assets/upload-url', {
      body: input,
      method: 'POST',
    })
  }

  /**
   * Reserve an upload the browser may send in parts: a file larger than one
   * part gets `multipart` instead of `uploadUrl` when storage takes parts.
   */
  async signAssetUploadInParts(input: BackendAssetUploadInput) {
    return this.request<{
      asset: BackendAsset
      uploadUrl: string
      multipart?: BackendAssetMultipart
    }>('v1/assets/upload-url', { body: { ...input, multipart: true }, method: 'POST' })
  }

  /** Which parts of a multipart upload storage holds, and signed PUTs for the parts asked for. */
  async signAssetUploadParts(id: string, parts: number[]) {
    return this.request<BackendAssetUploadParts>(
      `v1/assets/${encodeURIComponent(id)}/upload-parts`,
      { body: { parts }, method: 'POST' }
    )
  }

  /** Complete an upload; `partSha256` is each part's digest for a file sent in parts. */
  async completeAssetUpload(id: string, sha256?: string, partSha256?: string[]) {
    return this.request<{ asset: BackendAsset }>(`v1/assets/${encodeURIComponent(id)}/complete`, {
      body: { ...(sha256 ? { sha256 } : {}), ...(partSha256 ? { partSha256 } : {}) },
      method: 'POST',
    })
  }

  async signAssetDownload(id: string) {
    return this.request<{ downloadUrl: string }>(`v1/assets/${encodeURIComponent(id)}/download-url`)
  }

  /** Server-side asset read through the backend, where a browser URL is unreachable. */
  async readAsset(id: string) {
    return this.request<Uint8Array>(`v1/assets/${encodeURIComponent(id)}/bytes`, {
      responseType: 'bytes',
    })
  }

  /** Authenticated media response; keep its byte stream and range metadata. */
  async readAssetResponse(id: string, range?: string) {
    return this.request<Response>(`v1/assets/${encodeURIComponent(id)}/bytes`, {
      headers: range ? { range } : {},
      responseType: 'response',
    })
  }

  /** Redeem an opaque grant; Go rechecks its original principal on every read. */
  async readAssetDownload(id: string, token: string, range?: string) {
    return this.request<Response>(`v1/internal/assets/${encodeURIComponent(id)}/download`, {
      body: { token },
      headers: range ? { range } : {},
      method: 'POST',
      responseType: 'response',
    })
  }

  /** Describe an image; the description is posted with it (RFC 025). Empty clears it. */
  async setAssetAltText(id: string, altText: string) {
    return this.request<{ altText: string | null; id: string }>(
      `v1/assets/${encodeURIComponent(id)}/alt-text`,
      { body: { altText }, method: 'PUT' }
    )
  }

  async deleteAsset(id: string) {
    return this.request<{ status: 'deleted' }>(`v1/assets/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  }

  async storeGeneratedAsset(input: BackendGeneratedAssetInput) {
    return this.request<BackendGeneratedAsset>('v1/assets/generated', {
      headers: {
        'content-type': input.contentType,
        'x-asset-classification': input.classification,
        'x-asset-file-name': input.fileName,
        'x-asset-height': String(input.height),
        'x-asset-width': String(input.width),
        ...(input.parentAssetId ? { 'x-parent-asset-id': input.parentAssetId } : {}),
      },
      method: 'POST',
      rawBody: new Uint8Array(input.body).buffer,
    })
  }

  async consumeWorkspaceQuota(quota: string, amount = 1) {
    return this.request<{ remaining: number }>('v1/quotas/consume', {
      body: { amount, quota },
      method: 'POST',
    })
  }

  async listReleases(limit: number) {
    return this.request<{ releases: BackendReleaseListItem[] }>(`v1/releases?limit=${limit}`)
  }

  async getRelease(id: string) {
    return this.request<BackendReleaseDetail>(`v1/releases/${encodeURIComponent(id)}`)
  }

  async createRelease(input: BackendCreateReleaseInput) {
    return this.request<{ created: boolean; release: BackendReleaseSummary }>('v1/releases', {
      body: input,
      method: 'POST',
    })
  }

  async updateRelease(id: string, input: BackendUpdateReleaseInput) {
    return this.request<BackendReleaseDetail>(`v1/releases/${encodeURIComponent(id)}`, {
      body: input,
      method: 'PATCH',
    })
  }

  async listCampaigns() {
    return this.request<{ campaigns: BackendCampaignListItem[] }>('v1/campaigns')
  }

  async getCampaign(id: string) {
    return this.request<BackendCampaignDetail>(`v1/campaigns/${encodeURIComponent(id)}`)
  }

  async createCampaign(input: BackendCreateCampaignInput) {
    return this.request<BackendCampaignCreation>('v1/campaigns', { body: input, method: 'POST' })
  }

  /**
   * Validates an AI agent's OAuth request before the consent page shows it.
   * Only a signed-in owner or admin may connect an agent.
   */
  async previewAgentAuthorization(input: BackendAgentAuthorizationRequest) {
    return this.request<BackendAgentConsent>('v1/agent-authorizations/preview', {
      body: input,
      method: 'POST',
    })
  }

  /**
   * Records the member's consent and returns a single-use code; the agent
   * exchanges it at the MCP server's /oauth/token for a workspace API key with
   * exactly these scopes (RFC 026).
   */
  async approveAgentAuthorization(input: BackendAgentAuthorizationRequest) {
    return this.request<{ code: string; redirectUri: string }>('v1/agent-authorizations', {
      body: input,
      method: 'POST',
    })
  }

  /** The review queue: posts waiting for a reviewer's decision, oldest first. */
  async listPendingApprovals(options: { cursor?: string; limit: number }) {
    const parameters = new URLSearchParams({ limit: String(options.limit) })
    if (options.cursor) parameters.set('cursor', options.cursor)
    return this.request<BackendApprovalPage>(`v1/approvals?${parameters}`)
  }

  async transitionCampaign(id: string, status: BackendCampaignStatus) {
    return this.request<{ id: string; status: BackendCampaignStatus }>(
      `v1/campaigns/${encodeURIComponent(id)}/transition`,
      { body: { status }, method: 'POST' }
    )
  }

  async decideCampaignPosts(
    id: string,
    input: { decision: string; note?: string; postIds?: readonly string[] }
  ) {
    return this.request<{ postIds: string[]; status: BackendCampaignPost['status'] }>(
      `v1/campaigns/${encodeURIComponent(id)}/posts/decide`,
      { body: input, method: 'POST' }
    )
  }

  /**
   * Moves draft or needs-changes posts to review, every eligible post when
   * `postIds` is omitted. Unlike `decideCampaignPosts`, an API key with the
   * release:create scope may call it; nothing but a person approves.
   */
  async submitCampaignPosts(campaignId: string, postIds?: readonly string[]) {
    return this.request<{ postIds: string[]; status: BackendCampaignPost['status'] }>(
      `v1/campaigns/${encodeURIComponent(campaignId)}/posts/submit`,
      { body: postIds === undefined ? {} : { postIds }, method: 'POST' }
    )
  }

  /**
   * Turns an edited campaign visual into a Publish draft: the export is
   * attached to the campaign and the draft is created in one transaction, so
   * a failure leaves neither. `draft` is the ordinary draft body the composer
   * writes; its `requestKey` makes a retry return the first draft.
   */
  async createCampaignPublishDraft(campaignId: string, input: CampaignPublishDraftInput) {
    return this.request<BackendContentDraft>(
      `v1/campaigns/${encodeURIComponent(campaignId)}/publish-drafts`,
      { body: input, method: 'POST' }
    )
  }

  /** Edits a post's copy, call to action, or title; see `UpdateCampaignPostInput`. */
  async updateCampaignPost(campaignId: string, postId: string, input: UpdateCampaignPostInput) {
    return this.request<BackendCampaignPost>(
      `v1/campaigns/${encodeURIComponent(campaignId)}/posts/${encodeURIComponent(postId)}`,
      { body: input, method: 'PATCH' }
    )
  }

  async scheduleCampaignPost(
    campaignId: string,
    postId: string,
    input: { channelConnectionId: string; creativeVariantId?: string; scheduledAt?: string }
  ) {
    return this.request<BackendCampaignPost>(
      `v1/campaigns/${encodeURIComponent(campaignId)}/posts/${encodeURIComponent(postId)}/schedule`,
      { body: input, method: 'POST' }
    )
  }

  async listCampaignDesigns(campaignId: string) {
    return this.request<{ designs: BackendDesign[] }>(
      `v1/campaigns/${encodeURIComponent(campaignId)}/designs`
    )
  }

  /** Approves a design's current render for publishing; repeating it is a no-op. */
  async approveCampaignDesign(campaignId: string, designId: string) {
    return this.request<{ approval: BackendCreativeApproval; variant: BackendCreativeVariant }>(
      `v1/campaigns/${encodeURIComponent(campaignId)}/designs/${encodeURIComponent(designId)}/approval`,
      { method: 'POST' }
    )
  }

  /** Approves a campaign product shot through the design/render approval flow. */
  async approveCampaignAsset(campaignId: string, assetId: string) {
    return this.request<{ approval: BackendCreativeApproval; variant: BackendCreativeVariant }>(
      `v1/campaigns/${encodeURIComponent(campaignId)}/assets/${encodeURIComponent(assetId)}/approval`,
      { method: 'POST' }
    )
  }

  async createDesign(input: BackendCreateDesignInput) {
    return this.request<BackendDesign>('v1/designs', { body: input, method: 'POST' })
  }

  async getDesign(id: string) {
    return this.request<BackendDesign>(`v1/designs/${encodeURIComponent(id)}`)
  }

  async updateDesignDocument(id: string, document: unknown) {
    return this.request<{ updated: true }>(`v1/designs/${encodeURIComponent(id)}/document`, {
      body: { document },
      method: 'PUT',
    })
  }

  async setDesignRender(id: string, assetId: string, renderKey: string | null) {
    return this.request<{ updated: true }>(`v1/designs/${encodeURIComponent(id)}/render`, {
      body: { assetId, renderKey },
      method: 'PUT',
    })
  }

  async listContentDrafts(query: BackendContentDraftListQuery = {}) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value))
    }
    return this.request<{
      items: BackendContentDraft[]
      nextCursor: string | null
      pinned: BackendContentDraft[]
    }>(`v1/content-drafts?${params}`)
  }

  async createContentDraft(input: BackendContentDraftCreate) {
    return this.request<BackendContentDraft>('v1/content-drafts', { body: input, method: 'POST' })
  }

  async getContentDraft(id: string) {
    return this.request<BackendContentDraft>(`v1/content-drafts/${encodeURIComponent(id)}`)
  }

  /** Updates the fields set, based on `baseVersion`; a stale write fails with 409. */
  async updateContentDraft(id: string, input: BackendContentDraftUpdate) {
    return this.request<BackendContentDraft>(`v1/content-drafts/${encodeURIComponent(id)}`, {
      body: input,
      method: 'PATCH',
    })
  }

  /**
   * Schedules the draft at `version` to every target: one post per channel. A
   * repeat at the same version replays the same posts (`created: false`); a
   * stale version fails with 409; a new version cancels queued posts first.
   */
  /** Schedules at `scheduledFor`, or with `queue` at the set's next free slot, which the backend reserves. */
  async scheduleContentDraft(
    id: string,
    input: BackendScheduleTiming & {
      targets: BackendContentDraftScheduleTarget[]
      version: number
      baseCalendarVersion?: number
    }
  ) {
    return this.request<{
      created: boolean
      draft: BackendContentDraft
      posts: BackendContentDraftPost[]
    }>(`v1/content-drafts/${encodeURIComponent(id)}/schedule`, { body: input, method: 'POST' })
  }

  /** Writes a post and schedules or publishes it; a repeat with the same key replays it. */
  async createPost(input: Record<string, unknown> & { idempotencyKey: string }) {
    return this.request<{
      created: boolean
      draft: BackendContentDraft
      posts: BackendContentDraftPost[]
      reviewPath?: string
      status: 'awaiting_approval' | 'publishing' | 'scheduled'
    }>('v1/posts', { body: input, method: 'POST' })
  }

  /** A short-lived presence token; set documents keep their revision-checked persistence. */
  async createCreativeSetCollabToken(id: string) {
    return this.request<{
      access: 'read' | 'write'
      documentName: string
      expiresAt: string
      token: string
    }>(`v1/creative-sets/${encodeURIComponent(id)}/collab-token`, { body: {}, method: 'POST' })
  }

  /** A short-lived token admitting the signed-in member to the draft's live session. */
  async createContentDraftCollabToken(id: string) {
    return this.request<{
      access: 'read' | 'write'
      documentName: string
      expiresAt: string
      token: string
    }>(`v1/content-drafts/${encodeURIComponent(id)}/collab-token`, { body: {}, method: 'POST' })
  }

  async listContentDraftPosts(id: string) {
    return this.request<{ posts: BackendContentDraftPost[] }>(
      `v1/content-drafts/${encodeURIComponent(id)}/posts`
    )
  }

  async getContentDraftSettings() {
    return this.request<BackendContentDraftSettings>('v1/content-draft-settings')
  }

  async updateContentDraftSettings(input: {
    postingSlots?: { time: string; weekday: number }[]
    requireApproval?: boolean
    allowSelfApproval?: boolean
  }) {
    return this.request<BackendContentDraftSettings>('v1/content-draft-settings', {
      body: input,
      method: 'PUT',
    })
  }

  /** The queue's next free slot. */
  /** The next free slot of a set (the default set when omitted); it suggests, scheduling reserves. */
  async nextContentDraftQueueSlot(socialSetId = '') {
    const params = new URLSearchParams(socialSetId ? { socialSetId } : {})
    return this.request<{ scheduledFor: string }>(`v1/content-draft-queue/next?${params}`)
  }

  async bestPostingTimes(socialSetId = '') {
    const params = new URLSearchParams(socialSetId ? { socialSetId } : {})
    return this.request<{ items: BackendBestTime[] }>(`v1/content-draft-queue/best-times?${params}`)
  }

  /** Draft posts due in [from, to), for the calendar and the queue; optionally one set's. */
  async listContentDraftPostsBetween(from: Date, to: Date, socialSetId = '') {
    const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })
    if (socialSetId) params.set('socialSetId', socialSetId)
    return this.request<{ items: BackendCalendarPost[] }>(`v1/content-draft-posts?${params}`)
  }

  /** Drafts planned in [from, to); one set's when given. */
  async listPlannedContentDrafts(from: Date, to: Date, socialSetId?: string) {
    const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })
    if (socialSetId) params.set('socialSetId', socialSetId)
    return this.request<{ items: BackendContentDraft[] }>(`v1/content-draft-plans?${params}`)
  }

  /** What the set's account for a channel can mention (RFC 025). */
  async lookupSocialSetMentions(
    id: string,
    channel: 'x' | 'linkedin',
    query: string,
    kind?: 'person' | 'organization'
  ) {
    return this.request<{ items: BackendSocialMention[] }>(
      `v1/social-sets/${encodeURIComponent(id)}/mentions?${new URLSearchParams({ channel, q: query, ...(kind ? { kind } : {}) })}`
    )
  }

  /** Search communities through the social set's verified X account. */
  async searchSocialSetCommunities(id: string, query: string) {
    return this.request<{ items: { id: string; name: string }[] }>(
      `v1/social-sets/${encodeURIComponent(id)}/communities?${new URLSearchParams({ q: query })}`
    )
  }

  async listDraftTags(setId: string) {
    return this.request<{ items: BackendDraftTag[] }>(
      `v1/social-sets/${encodeURIComponent(setId)}/tags`
    )
  }

  async createDraftTag(setId: string, input: { color?: string; name: string }) {
    return this.request<BackendDraftTag>(`v1/social-sets/${encodeURIComponent(setId)}/tags`, {
      body: input,
      method: 'POST',
    })
  }

  async updateDraftTag(setId: string, tagId: string, input: { color?: string; name?: string }) {
    return this.request<BackendDraftTag>(
      `v1/social-sets/${encodeURIComponent(setId)}/tags/${encodeURIComponent(tagId)}`,
      { body: input, method: 'PATCH' }
    )
  }

  async deleteDraftTag(setId: string, tagId: string) {
    return this.request<{ deleted: true }>(
      `v1/social-sets/${encodeURIComponent(setId)}/tags/${encodeURIComponent(tagId)}`,
      { method: 'DELETE' }
    )
  }

  async listDraftFinishers(setId: string) {
    return this.request<{ items: BackendDraftFinisher[] }>(
      `v1/social-sets/${encodeURIComponent(setId)}/finishers`
    )
  }

  async createDraftFinisher(
    setId: string,
    input: { name: string; quoteFirstPost?: boolean; text: string }
  ) {
    return this.request<BackendDraftFinisher>(
      `v1/social-sets/${encodeURIComponent(setId)}/finishers`,
      {
        body: input,
        method: 'POST',
      }
    )
  }

  async updateDraftFinisher(
    setId: string,
    finisherId: string,
    input: { name?: string; quoteFirstPost?: boolean; text?: string }
  ) {
    return this.request<BackendDraftFinisher>(
      `v1/social-sets/${encodeURIComponent(setId)}/finishers/${encodeURIComponent(finisherId)}`,
      { body: input, method: 'PATCH' }
    )
  }

  async deleteDraftFinisher(setId: string, finisherId: string) {
    return this.request<{ deleted: true }>(
      `v1/social-sets/${encodeURIComponent(setId)}/finishers/${encodeURIComponent(finisherId)}`,
      { method: 'DELETE' }
    )
  }

  /** Pin, tag or annotate a draft; its version and approval stay. */
  async updateContentDraftProperties(
    id: string,
    input: {
      addTagIds?: string[]
      pinned?: boolean
      removeTagIds?: string[]
      scratchpad?: string
      suppressSlackOnPublish?: boolean
    }
  ) {
    return this.request<BackendContentDraft>(
      `v1/content-drafts/${encodeURIComponent(id)}/properties`,
      {
        body: input,
        method: 'PATCH',
      }
    )
  }

  /** Plan a draft on the calendar, or clear its plan with null. Nothing publishes from a plan. */
  async mutateCalendar(input: unknown) {
    return this.request<unknown>('v1/calendar/mutations', { body: input, method: 'POST' })
  }
  /** How many accounts the workspace holds and may hold; a null limit means none. */
  async socialConnectionCapacity() {
    return this.request<{ held: number; limit: number | null }>('v1/social-connection-capacity')
  }
  /** A workspace's date-only notes on the days from..to, inclusive. */
  async listCalendarNotes(from: string, to: string) {
    const params = new URLSearchParams({ from, to })
    return this.request<unknown>(`v1/calendar/notes?${params}`)
  }
  async createCalendarNote(input: unknown) {
    return this.request<unknown>('v1/calendar/notes', { body: input, method: 'POST' })
  }
  async updateCalendarNote(id: string, input: unknown) {
    return this.request<unknown>(`v1/calendar/notes/${encodeURIComponent(id)}`, {
      body: input,
      method: 'PATCH',
    })
  }
  async deleteCalendarNote(id: string) {
    return this.request<{ deleted: boolean }>(`v1/calendar/notes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  }
  /** The workspace's voice switches, the member's choices, limits and server-side switches. */
  async getVoiceSettings() {
    return this.request<unknown>('v1/voice/settings')
  }
  async updateVoiceWorkspaceSettings(input: unknown) {
    return this.request<unknown>('v1/voice/settings/workspace', { body: input, method: 'PUT' })
  }
  async updateVoiceMemberSettings(input: unknown) {
    return this.request<unknown>('v1/voice/settings/member', { body: input, method: 'PUT' })
  }
  /** Every note of the member's, tombstones included, for the phone's list comparison. */
  async listVoiceNoteIndex() {
    return this.request<unknown>('v1/voice/notes/index')
  }
  async listVoiceNotes(query: { cursor?: string; limit?: number }) {
    const params = new URLSearchParams()
    if (query.cursor) params.set('cursor', query.cursor)
    if (query.limit) params.set('limit', String(query.limit))
    return this.request<unknown>(`v1/voice/notes${params.size ? `?${params}` : ''}`)
  }
  /** `created` is false for a replay of the same client note id. */
  async createVoiceNote(input: unknown) {
    return this.created('v1/voice/notes', input)
  }
  async getVoiceNote(id: string) {
    return this.request<unknown>(`v1/voice/notes/${encodeURIComponent(id)}`)
  }
  async updateVoiceNote(id: string, input: unknown) {
    return this.request<unknown>(`v1/voice/notes/${encodeURIComponent(id)}`, {
      body: input,
      method: 'PATCH',
    })
  }
  async deleteVoiceNote(id: string) {
    await this.request<Response>(`v1/voice/notes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      responseType: 'response',
    })
  }
  /** `created` is false for a replay of the same client revision id. */
  async addVoiceTranscript(id: string, input: unknown) {
    return this.created(`v1/voice/notes/${encodeURIComponent(id)}/transcripts`, input)
  }
  async redactVoiceTranscript(id: string, revisionId: string) {
    return this.request<unknown>(
      `v1/voice/notes/${encodeURIComponent(id)}/transcripts/${encodeURIComponent(revisionId)}/redact`,
      { method: 'POST' }
    )
  }
  async createVoiceRunUpload(id: string, runIndex: number, input: unknown) {
    return this.request<unknown>(
      `v1/voice/notes/${encodeURIComponent(id)}/runs/${runIndex}/upload`,
      {
        body: input,
        method: 'POST',
      }
    )
  }
  async completeVoiceRun(id: string, runIndex: number) {
    return this.request<unknown>(
      `v1/voice/notes/${encodeURIComponent(id)}/runs/${runIndex}/complete`,
      { method: 'POST' }
    )
  }
  async getVoiceRunAudio(id: string, runIndex: number) {
    return this.request<unknown>(`v1/voice/notes/${encodeURIComponent(id)}/runs/${runIndex}/audio`)
  }
  async deleteVoiceAudio(id: string) {
    await this.request<Response>(`v1/voice/notes/${encodeURIComponent(id)}/audio`, {
      method: 'DELETE',
      responseType: 'response',
    })
  }
  async createVoiceDraft(id: string, input: unknown) {
    return this.request<unknown>(`v1/voice/notes/${encodeURIComponent(id)}/draft`, {
      body: input,
      method: 'POST',
    })
  }
  async confirmVoiceCommand(id: string, input: unknown) {
    return this.request<unknown>(`v1/voice/notes/${encodeURIComponent(id)}/command/confirm`, {
      body: input,
      method: 'POST',
    })
  }
  /** An idempotent create: the body, and whether the backend answered 201 rather than a replay's 200. */
  private async created(path: string, input: unknown) {
    const response = await this.request<Response>(path, {
      body: input,
      method: 'POST',
      responseType: 'response',
    })
    return { body: (await response.json()) as unknown, created: response.status === 201 }
  }
  async getAnalytics(id: string, query: Record<string, string | number | undefined>) {
    const params = new URLSearchParams(
      Object.entries(query)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)])
    )
    return this.request<unknown>(`v1/analytics/${encodeURIComponent(id)}?${params}`)
  }
  async refreshAnalytics(id: string) {
    return this.request<{ refreshed: boolean }>(`v1/analytics/${encodeURIComponent(id)}/refresh`, {
      method: 'POST',
      body: {},
    })
  }
  async updateAnalyticsSettings(id: string, input: unknown) {
    return this.request<unknown>(`v1/analytics/${encodeURIComponent(id)}/settings`, {
      method: 'PUT',
      body: input,
    })
  }
  async getPublicAnalytics(token: string, query: Record<string, string | number | undefined>) {
    const params = new URLSearchParams(
      Object.entries(query)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)])
    )
    return this.request<unknown>(`v1/internal/analytics/${encodeURIComponent(token)}?${params}`)
  }

  async planContentDraft(
    id: string,
    input: { baseCalendarVersion?: number; plannedFor: Date | null; timeZone?: string }
  ) {
    return this.request<BackendContentDraft>(`v1/content-drafts/${encodeURIComponent(id)}/plan`, {
      body: input,
      method: 'POST',
    })
  }

  async duplicateContentDraft(id: string, requestKey?: string) {
    return this.request<BackendDraftCopy>(
      `v1/content-drafts/${encodeURIComponent(id)}/duplicate${requestKey ? `?requestKey=${encodeURIComponent(requestKey)}` : ''}`,
      {
        body: {},
        method: 'POST',
      }
    )
  }

  async copyContentDraft(id: string, input: { socialSetId: string; tagMode: 'match' | 'drop' }) {
    return this.request<BackendDraftCopy>(`v1/content-drafts/${encodeURIComponent(id)}/copy`, {
      body: input,
      method: 'POST',
    })
  }

  /** A new draft from a backup; the source stays as it is. */
  async recoverContentDraftRevision(id: string, revisionId: string) {
    return this.request<BackendDraftCopy>(
      `v1/content-drafts/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}/recover`,
      { body: {}, method: 'POST' }
    )
  }

  async listContentDraftActivity(id: string) {
    return this.request<{ items: BackendDraftActivity[] }>(
      `v1/content-drafts/${encodeURIComponent(id)}/activity`
    )
  }

  /** Atomically exchange two queued post times; never publishes immediately. */
  async swapContentDraftPostTimes(first: string, second: string) {
    return this.request<{ posts: Array<{ post: BackendContentDraftPost }> }>(
      'v1/content-draft-posts/swap',
      { body: { first, second }, method: 'POST' }
    )
  }

  async moveContentDraftPost(id: string, scheduledFor: Date) {
    return this.request<{ post: BackendContentDraftPost }>(
      `v1/content-draft-posts/${encodeURIComponent(id)}/move`,
      { body: { scheduledFor }, method: 'POST' }
    )
  }

  /** Atomically swap two queued posts on the same account. */
  async swapContentDraftPosts(id: string, withId: string) {
    return this.request<{ posts: BackendContentDraftPost[] }>(
      `v1/content-draft-posts/${encodeURIComponent(id)}/swap`,
      { body: { withId }, method: 'POST' }
    )
  }

  /** Publish the immutable queued snapshot once, immediately. */
  async publishQueuedContentDraftPost(id: string) {
    return this.request<{ post: BackendContentDraftPost }>(
      `v1/content-draft-posts/${encodeURIComponent(id)}/publish-now`,
      { body: {}, method: 'POST' }
    )
  }

  /** Publish one failed destination again, now; once. */
  async retryContentDraftPost(id: string) {
    return this.request<{ post: BackendContentDraftPost }>(
      `v1/content-draft-posts/${encodeURIComponent(id)}/retry`,
      { body: {}, method: 'POST' }
    )
  }

  /** Settle a post whose outcome was unknown: live (with its URL) or not live. */
  async reconcileContentDraftPost(id: string, input: { live: boolean; url?: string }) {
    return this.request<{ post: BackendContentDraftPost }>(
      `v1/content-draft-posts/${encodeURIComponent(id)}/reconcile`,
      { body: input, method: 'POST' }
    )
  }

  /** Stop a live post's pending follow-ups; removals of automatic reposts still run. */
  async cancelContentDraftPostAutomations(id: string) {
    return this.request<{ post: BackendContentDraftPost }>(
      `v1/content-draft-posts/${encodeURIComponent(id)}/automations/cancel`,
      { body: {}, method: 'POST' }
    )
  }

  /** Post the rest of a thread that stopped partway. */
  async resumeContentDraftThread(id: string) {
    return this.request<{ post: BackendContentDraftPost }>(
      `v1/content-draft-posts/${encodeURIComponent(id)}/resume`,
      { body: {}, method: 'POST' }
    )
  }

  /** Read bounded, timestamped analytics for a visible social set. */
  async previewDraftBatchTimes(input: {
    socialSetId: string
    count: number
    mode: 'queue' | 'spread'
    localTime?: string
    postsPerDay?: number
    spacingMinutes?: number
    shiftMinutes?: number
    seed: string
  }) {
    return this.request<{ times: string[] }>('v1/content-draft-batch/times', {
      method: 'POST',
      body: input,
    })
  }

  /** Open batches in the social sets this member can see, newest first. */
  async listContentBatches() {
    return this.request<{ batches: BackendContentBatch[] }>('v1/content-batches')
  }

  /** Start a durable batch in a social set (the default set when omitted). */
  async createContentBatch(input: { socialSetId?: string; title: string }) {
    return this.request<BackendContentBatch>('v1/content-batches', { body: input, method: 'POST' })
  }

  /** A batch with every item, its media facts, its draft and that draft's posts. */
  async getContentBatch(id: string) {
    return this.request<BackendContentBatch>(`v1/content-batches/${encodeURIComponent(id)}`)
  }

  /** Close a batch; its drafts and posts stay. */
  async archiveContentBatch(id: string) {
    await this.request<Response>(`v1/content-batches/${encodeURIComponent(id)}/archive`, {
      body: {},
      method: 'POST',
      responseType: 'response',
    })
  }

  /** Stage items; a retried import key returns its item, other content under it is a 409. */
  async addContentBatchItems(id: string, items: BackendContentBatchItemInput[]) {
    return this.request<BackendContentBatch>(`v1/content-batches/${encodeURIComponent(id)}/items`, {
      body: { items },
      method: 'POST',
    })
  }

  /** Change a staged item, or a drafted item's time and order. */
  async updateContentBatchItem(
    id: string,
    itemId: string,
    input: Partial<
      Pick<
        BackendContentBatchItemInput,
        'caption' | 'channelConnectionIds' | 'grid' | 'media' | 'timing'
      >
    > & {
      position?: number
    }
  ) {
    return this.request<BackendContentBatchItem>(
      `v1/content-batches/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`,
      { body: input, method: 'PATCH' }
    )
  }

  /** Change many items as one operation: a refused item refuses them all. */
  async updateContentBatchItems(
    id: string,
    items: (Partial<
      Pick<
        BackendContentBatchItemInput,
        'caption' | 'channelConnectionIds' | 'grid' | 'media' | 'timing'
      >
    > & { itemId: string; position?: number })[]
  ) {
    return this.request<BackendContentBatch>(`v1/content-batches/${encodeURIComponent(id)}/items`, {
      body: { items },
      method: 'PATCH',
    })
  }

  /** Schedule frozen requests in the background; the same key replays its run. */
  async submitContentBatch(
    id: string,
    input: {
      items: {
        channelConnectionIds: string[]
        itemId: string
        refusal?: string
        schedule?: Parameters<ScreenshotStudioBackendSDK['scheduleContentDraft']>[1]
      }[]
      requestKey: string
    }
  ) {
    return this.request<BackendContentBatchRun>(
      `v1/content-batches/${encodeURIComponent(id)}/submit`,
      { body: input, method: 'POST' }
    )
  }

  /** What a schedule or render of a batch did. */
  async getContentBatchRun(id: string, runId: string) {
    return this.request<BackendContentBatchRun>(
      `v1/content-batches/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`
    )
  }

  /** Freeze grid concepts for a browser to render; the same key replays its run. */
  async createContentBatchRender(id: string, input: { itemIds: string[]; requestKey: string }) {
    return this.request<BackendContentBatchRun>(
      `v1/content-batches/${encodeURIComponent(id)}/renders`,
      { body: input, method: 'POST' }
    )
  }

  /** Record a rendered video on its item, or why it failed. */
  async reportContentBatchRender(
    id: string,
    runId: string,
    itemId: string,
    input: { assetId?: string; error?: string; fileName?: string }
  ) {
    return this.request<BackendContentBatchRun>(
      `v1/content-batches/${encodeURIComponent(id)}/renders/${encodeURIComponent(runId)}/items/${encodeURIComponent(itemId)}`,
      { body: input, method: 'POST' }
    )
  }

  /** Take an item out of its batch; a draft it made stays in Write. */
  async removeContentBatchItem(id: string, itemId: string) {
    await this.request<Response>(
      `v1/content-batches/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`,
      { method: 'DELETE', responseType: 'response' }
    )
  }

  /** Save an item as its draft; a retry returns the same draft. */
  async createContentBatchItemDraft(id: string, itemId: string, input: BackendContentDraftCreate) {
    return this.request<BackendContentBatchItem>(
      `v1/content-batches/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/draft`,
      { body: input, method: 'POST' }
    )
  }

  /** Check each item and account apart with scheduling's gates, without charging or reserving. */
  async validateContentBatch(
    id: string,
    items: { itemId: string; targets: BackendContentDraftScheduleTarget[]; version: number }[]
  ) {
    return this.request<{ results: BackendBatchValidation[] }>(
      `v1/content-batches/${encodeURIComponent(id)}/validate`,
      { body: { items }, method: 'POST' }
    )
  }

  /** Validate a schedule without revisions, quota charges or publication. */
  async validateContentDraftSchedule(
    id: string,
    input: BackendScheduleTiming & { version: number; targets: BackendContentDraftScheduleTarget[] }
  ) {
    return this.request<{ valid: true }>(
      `v1/content-drafts/${encodeURIComponent(id)}/schedule/validate`,
      { method: 'POST', body: input }
    )
  }

  /** Read stored provider observations for a visible set. */
  async listSocialAnalytics(query: { socialSetId: string; from: string; to: string }) {
    const result = await this.request<{ items: unknown[] }>(
      `v1/social-analytics?${new URLSearchParams(query)}`
    )
    return { items: result.items.map((item) => socialObservationSchema.parse(item)) }
  }

  async refreshContentDraftPostMetrics(id: string) {
    return this.request<BackendContentDraftPost>(
      `v1/content-draft-posts/${encodeURIComponent(id)}/metrics`,
      { body: {}, method: 'POST' }
    )
  }

  async reviewContentDraft(
    id: string,
    input: { action: 'request' | 'approve' | 'changes'; version: number; note?: string }
  ) {
    return this.request<BackendContentDraft>(`v1/content-drafts/${encodeURIComponent(id)}/review`, {
      body: input,
      method: 'POST',
    })
  }

  /** Apply a comment-only action with revision conflict protection. */
  /** Read the existing discussion document with optional lifecycle and platform filters. */
  async listContentDraftComments(
    id: string,
    query: { status?: 'all' | 'open' | 'resolved'; platform?: string } = {}
  ) {
    const params = new URLSearchParams(
      Object.fromEntries(
        Object.entries(query).filter(([, value]) => value !== undefined)
      ) as Record<string, string>
    )
    return this.request<{ id: string; version: number; discussions: Record<string, unknown> }>(
      `v1/content-drafts/${encodeURIComponent(id)}/comments?${params}`
    )
  }

  async mutateContentDraftComment(id: string, input: DraftCommentInput) {
    return this.request<BackendContentDraft>(
      `v1/content-drafts/${encodeURIComponent(id)}/comments`,
      { body: draftCommentInputSchema.parse(input), method: 'POST' }
    )
  }

  async shareContentDraft(id: string, enabled: boolean) {
    return this.request<BackendContentDraft>(`v1/content-drafts/${encodeURIComponent(id)}/share`, {
      body: { enabled },
      method: 'PUT',
    })
  }

  async listContentDraftRevisions(id: string) {
    return this.request<{ items: BackendContentDraftRevision[] }>(
      `v1/content-drafts/${encodeURIComponent(id)}/revisions`
    )
  }

  async getContentDraftRevision(id: string, revisionId: string) {
    return this.request<BackendContentDraftRevision>(
      `v1/content-drafts/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}`
    )
  }

  /** A guest's view of a shared draft (service credential). */
  /** Read only the current shared image; the share token is checked again after storage. */
  async readSharedDraftImage(token: string) {
    return this.request<Uint8Array>(
      `v1/internal/content-draft-shares/${encodeURIComponent(token)}/image`,
      { responseType: 'bytes' }
    )
  }

  async getSharedContentDraft(token: string) {
    return this.request<BackendSharedContentDraft>(
      `v1/internal/content-draft-shares/${encodeURIComponent(token)}`
    )
  }

  /** The signed-in person's preferences (RFC 024). */
  async getUserPreferences() {
    return this.request<UserPreferences>('v1/me/preferences')
  }

  /** Saves the preferences set; a stale `baseVersion` fails with 409. */
  async updateUserPreferences(input: UserPreferencesUpdate) {
    return this.request<UserPreferences>('v1/me/preferences', { body: input, method: 'PATCH' })
  }

  async getAccountDeletion() {
    return this.request<AccountDeletionStatus>('v1/me/account-deletion')
  }

  /** Schedules the person's account for deletion after its grace period. */
  async requestAccountDeletion(confirmation: string) {
    return this.request<AccountDeletionStatus>('v1/me/account-deletion', {
      body: { confirmation },
      method: 'POST',
    })
  }

  async cancelAccountDeletion() {
    return this.request<AccountDeletionStatus>('v1/me/account-deletion', { method: 'DELETE' })
  }

  async listExperiments() {
    return this.request<{ items: ExperimentState[] }>('v1/experiments')
  }

  /** Turns an experiment off, or back on, for the whole workspace (owners and admins). */
  async setWorkspaceExperiment(id: string, disabled: boolean) {
    return this.request<{ items: ExperimentState[] }>(
      `v1/experiments/${encodeURIComponent(id)}/workspace`,
      { body: { disabled }, method: 'PUT' }
    )
  }

  async listSocialSets() {
    return this.request<SocialSetList>('v1/social-sets')
  }

  async getSocialSet(id: string) {
    return this.request<SocialSet>(`v1/social-sets/${encodeURIComponent(id)}`)
  }

  async createSocialSet(input: SocialSetInput) {
    return this.request<SocialSet>('v1/social-sets', { body: input, method: 'POST' })
  }

  async updateSocialSet(id: string, input: SocialSetUpdate) {
    return this.request<SocialSet>(`v1/social-sets/${encodeURIComponent(id)}`, {
      body: input,
      method: 'PATCH',
    })
  }

  /** Change future queue defaults without moving existing deliveries. */
  async updateSocialSetQueue(
    id: string,
    input: Pick<
      SocialSetUpdate,
      'baseVersion' | 'timeZone' | 'postingSlots' | 'naturalPostingTimes'
    >
  ) {
    return this.request<SocialSet>(`v1/social-sets/${encodeURIComponent(id)}/queue`, {
      body: input,
      method: 'PATCH',
    })
  }

  /** Deletes a set; `confirmation` is its name. */
  async deleteSocialSet(id: string, confirmation: string) {
    return this.request<SocialSetRemoval>(`v1/social-sets/${encodeURIComponent(id)}`, {
      body: { confirmation },
      method: 'DELETE',
    })
  }

  /** Shares a private set with the workspace; only its owner can. */
  async shareSocialSet(id: string) {
    return this.request<SocialSet>(`v1/social-sets/${encodeURIComponent(id)}/share`, {
      body: {},
      method: 'POST',
    })
  }

  async assignSocialSetAccount(id: string, connectionId: string) {
    return this.request<SocialSet>(
      `v1/social-sets/${encodeURIComponent(id)}/accounts/${encodeURIComponent(connectionId)}`,
      { body: {}, method: 'POST' }
    )
  }

  /** Removes an account from a set; its queued posts are cancelled. */
  async removeSocialSetAccount(id: string, connectionId: string) {
    return this.request<SocialSetRemoval>(
      `v1/social-sets/${encodeURIComponent(id)}/accounts/${encodeURIComponent(connectionId)}`,
      { method: 'DELETE' }
    )
  }

  async listCopyableSocialSets() {
    return this.request<{ items: CopyableSocialSet[] }>('v1/social-sets/copyable')
  }

  async copySocialSet(workspaceId: string, socialSetId: string) {
    return this.request<SocialSet>('v1/social-sets/copy', {
      body: { socialSetId, workspaceId },
      method: 'POST',
    })
  }

  async updateWritingAssistant(
    id: string,
    input: {
      action?: 'create' | 'disable' | 'enable'
      baseVersion: number
      styleGuide?: StyleGuide
    }
  ) {
    return this.request<SocialSet>(`v1/social-sets/${encodeURIComponent(id)}/writing-assistant`, {
      body: input,
      method: 'PUT',
    })
  }

  async listWritingSamples(id: string) {
    return this.request<{ items: WritingSample[] }>(
      `v1/social-sets/${encodeURIComponent(id)}/writing-samples`
    )
  }

  async addWritingSample(id: string, input: { draftId?: string; text?: string }) {
    return this.request<WritingSample>(`v1/social-sets/${encodeURIComponent(id)}/writing-samples`, {
      body: input,
      method: 'POST',
    })
  }

  async deleteWritingSample(id: string, sampleId: string) {
    return this.request<{ deleted: true }>(
      `v1/social-sets/${encodeURIComponent(id)}/writing-samples/${encodeURIComponent(sampleId)}`,
      { method: 'DELETE' }
    )
  }

  /** The brand voice refined by the draft's set, for AI help on a channel. */
  async getDraftWritingContext(id: string, channel: string) {
    return this.request<WritingContext>(
      `v1/content-drafts/${encodeURIComponent(id)}/writing-context?channel=${encodeURIComponent(channel)}`
    )
  }

  /** The same voice for a set with no draft yet, for copy written before one exists. */
  async getSocialSetWritingContext(id: string, channel: string) {
    return this.request<WritingContext>(
      `v1/social-sets/${encodeURIComponent(id)}/writing-context?channel=${encodeURIComponent(channel)}`
    )
  }

  /** A set's public profile (service credential); not found while it is off. */
  async getPublicProfile(slug: string) {
    return this.request<PublicProfile>(`v1/internal/public-profiles/${encodeURIComponent(slug)}`)
  }

  async listWebhooks() {
    return this.request<{ events: string[]; items: Webhook[] }>('v1/webhooks')
  }

  /** The secret in the result is shown this once. */
  async createWebhook(input: { events: string[]; name: string; url: string }) {
    return this.request<WebhookWithSecret>('v1/webhooks', { body: input, method: 'POST' })
  }

  async updateWebhook(
    id: string,
    input: { enabled?: boolean; events?: string[]; name?: string; url?: string }
  ) {
    return this.request<Webhook>(`v1/webhooks/${encodeURIComponent(id)}`, {
      body: input,
      method: 'PATCH',
    })
  }

  async deleteWebhook(id: string) {
    return this.request<{ deleted: true }>(`v1/webhooks/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  }

  /** A new secret, shown this once; the old one keeps signing for 24 hours. */
  async rotateWebhookSecret(id: string) {
    return this.request<WebhookWithSecret>(`v1/webhooks/${encodeURIComponent(id)}/rotate`, {
      body: {},
      method: 'POST',
    })
  }

  async testWebhook(id: string) {
    return this.request<WebhookDelivery>(`v1/webhooks/${encodeURIComponent(id)}/test`, {
      body: {},
      method: 'POST',
    })
  }

  async listWebhookDeliveries(id: string) {
    return this.request<{ items: WebhookDelivery[] }>(
      `v1/webhooks/${encodeURIComponent(id)}/deliveries`
    )
  }

  /** Replays a delivery that stopped retrying, with the same event ID. */
  async retryWebhookDelivery(id: string) {
    return this.request<WebhookDelivery>(`v1/webhook-deliveries/${encodeURIComponent(id)}/retry`, {
      body: {},
      method: 'POST',
    })
  }

  /** A guest's comment on a shared draft (service credential). */
  async addGuestComment(token: string, input: { name: string; text: string }) {
    return this.request<BackendSharedContentDraft>(
      `v1/internal/content-draft-shares/${encodeURIComponent(token)}/comments`,
      { body: input, method: 'POST' }
    )
  }

  async deleteContentDraft(id: string, expected?: { version?: number; calendarVersion?: number }) {
    const params = new URLSearchParams(
      Object.entries(expected ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)])
    )
    return this.request<{ deleted: true }>(
      `v1/content-drafts/${encodeURIComponent(id)}?${params}`,
      {
        method: 'DELETE',
      }
    )
  }

  async listProjects(query: BackendProjectListQuery = {}) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value))
    }
    return this.request<{ items: BackendProject[]; nextCursor: string | null }>(
      `v1/projects?${params}`
    )
  }

  async createProject(input: { document: unknown; name: string }) {
    return this.request<BackendProject>('v1/projects', { body: input, method: 'POST' })
  }

  async getProject(id: string) {
    return this.request<BackendProject>(`v1/projects/${encodeURIComponent(id)}`)
  }

  async renameProject(id: string, name: string) {
    return this.request<BackendProject>(`v1/projects/${encodeURIComponent(id)}`, {
      body: { name },
      method: 'PATCH',
    })
  }

  /** Writes a document based on `baseRevision`; a stale write fails with 409 and `currentRevision`. */
  async updateProjectDocument(id: string, input: { baseRevision: number; document: unknown }) {
    return this.request<{ revision: number; updatedAt: string }>(
      `v1/projects/${encodeURIComponent(id)}/document`,
      { body: input, method: 'PUT' }
    )
  }

  async duplicateProject(id: string, name?: string) {
    return this.request<BackendProject>(`v1/projects/${encodeURIComponent(id)}/duplicate`, {
      body: name === undefined ? {} : { name },
      method: 'POST',
    })
  }

  async deleteProject(id: string) {
    return this.request<{ deleted: true }>(`v1/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  }

  async listProjectVersions(id: string) {
    return this.request<{ versions: BackendProjectVersion[] }>(
      `v1/projects/${encodeURIComponent(id)}/versions`
    )
  }

  async getProjectVersion(id: string, versionId: string) {
    return this.request<BackendProjectVersion & { document: Record<string, unknown> }>(
      `v1/projects/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`
    )
  }

  /** Names the project's current document as a version. */
  async createProjectVersion(id: string, name: string) {
    return this.request<BackendProjectVersion>(`v1/projects/${encodeURIComponent(id)}/versions`, {
      body: { name },
      method: 'POST',
    })
  }

  /** Makes a version the current document, as a new revision based on `baseRevision`. */
  async restoreProjectVersion(id: string, versionId: string, baseRevision: number) {
    return this.request<BackendProject>(
      `v1/projects/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`,
      { body: { baseRevision }, method: 'POST' }
    )
  }

  async listCreativeSets(query: BackendCreativeSetListQuery = {}) {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') params.set(key, String(value))
    }
    return this.request<{ items: BackendCreativeSet[]; nextCursor: string | null }>(
      `v1/creative-sets?${params}`
    )
  }

  async createCreativeSet(input: { id: string; document: unknown; name: string }) {
    return this.request<BackendCreativeSet>('v1/creative-sets', { body: input, method: 'POST' })
  }

  async getCreativeSet(id: string) {
    return this.request<BackendCreativeSet>(`v1/creative-sets/${encodeURIComponent(id)}`)
  }

  async renameCreativeSet(id: string, name: string) {
    return this.request<BackendCreativeSet>(`v1/creative-sets/${encodeURIComponent(id)}`, {
      body: { name },
      method: 'PATCH',
    })
  }

  /** Writes a document based on `baseRevision`; a stale write fails with 409 and `currentRevision`. */
  async updateCreativeSetDocument(id: string, input: { baseRevision: number; document: unknown }) {
    return this.request<{ revision: number; updatedAt: string }>(
      `v1/creative-sets/${encodeURIComponent(id)}/document`,
      { body: input, method: 'PUT' }
    )
  }

  async duplicateCreativeSet(id: string, name?: string) {
    return this.request<BackendCreativeSet>(
      `v1/creative-sets/${encodeURIComponent(id)}/duplicate`,
      {
        body: name === undefined ? {} : { name },
        method: 'POST',
      }
    )
  }

  /** Permanently remove a canvas and its versions; delivered assets are retained. */
  async deleteCanvas(id: string) {
    return this.request<{ deleted: boolean }>(`v1/canvases/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  }

  /** Permanently remove a workspace's store screenshot project and its versions; browser copies stay. */
  async deleteStoreProject(id: string) {
    return this.request<{ deleted: boolean }>(`v1/store-projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  }

  async archiveCreativeSet(id: string, archived = true) {
    return this.request<{ archived: boolean }>(
      `v1/creative-sets/${encodeURIComponent(id)}/archive?archived=${archived}`,
      {
        method: 'POST',
      }
    )
  }

  async listCreativeSetVersions(id: string) {
    return this.request<{ versions: BackendCreativeSetVersion[] }>(
      `v1/creative-sets/${encodeURIComponent(id)}/versions`
    )
  }

  async getCreativeSetVersion(id: string, versionId: string) {
    return this.request<BackendCreativeSetVersion & { document: Record<string, unknown> }>(
      `v1/creative-sets/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`
    )
  }

  /** Names the creativeSet's current document as a version. */
  async createCreativeSetVersion(id: string, name: string, baseRevision?: number) {
    return this.request<BackendCreativeSetVersion>(
      `v1/creative-sets/${encodeURIComponent(id)}/versions`,
      {
        body: { name, baseRevision },
        method: 'POST',
      }
    )
  }

  /** Attach an immutable delivered revision to campaign review, idempotently. */
  async attachCreativeSetDelivery(
    id: string,
    input: {
      baseRevision: number
      deliveryId: string
      campaignId: string
      channel: string
      copy: string
    }
  ) {
    return this.request<{ campaignId: string; designId: string; postId: string }>(
      `v1/creative-sets/${encodeURIComponent(id)}/campaign`,
      { body: input, method: 'POST' }
    )
  }

  /** Makes a version the current document, as a new revision based on `baseRevision`. */
  async restoreCreativeSetVersion(id: string, versionId: string, baseRevision: number) {
    return this.request<BackendCreativeSet>(
      `v1/creative-sets/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`,
      { body: { baseRevision }, method: 'POST' }
    )
  }

  /** Read the code a GitHub file, pull request, commit or gist link points to; nothing is stored. */
  async importCode(url: string) {
    return this.request<BackendCodeImport>('v1/code-imports', { body: { url }, method: 'POST' })
  }

  async listShareLinks() {
    return this.request<{ shareLinks: BackendShareLink[] }>('v1/share-links')
  }

  async getShareLink(id: string) {
    return this.request<BackendShareLink>(`v1/share-links/${encodeURIComponent(id)}`)
  }

  async createShareLink(input: {
    access: ShareLinkAccess
    altText?: string | null
    assetId: string
    description?: string | null
    expiresAt?: string | null
    posterAssetId?: string | null
    projectId?: string | null
    title: string
    /** A Code Studio document to embed as text; frozen when the link is made. */
    code?: Record<string, unknown>
  }) {
    return this.request<BackendShareLink>('v1/share-links', { body: input, method: 'POST' })
  }

  async updateShareLink(
    id: string,
    input: {
      access?: ShareLinkAccess
      altText?: string | null
      clearExpiry?: boolean
      description?: string | null
      expiresAt?: string | null
      title?: string
    }
  ) {
    return this.request<BackendShareLink>(`v1/share-links/${encodeURIComponent(id)}`, {
      body: input,
      method: 'PATCH',
    })
  }

  async revokeShareLink(id: string) {
    return this.request<{ revoked: true }>(`v1/share-links/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  }

  /** A live link by its token, for the share page; requires the service token alone. */
  async resolveShareLink(token: string) {
    return this.request<BackendPublicShareLink>(
      `v1/internal/share-links/${encodeURIComponent(token)}`
    )
  }

  /** A short-lived signed URL for a live link's media or poster; requires the service token alone. */
  async shareLinkObjectUrl(token: string, variant: 'media' | 'poster') {
    return this.request<{ mediaType: string; url: string }>(
      `v1/internal/share-links/${encodeURIComponent(token)}/object-url?variant=${variant}`
    )
  }

  /** Current workspace policy and the authenticated member's preferences. */
  notificationSettings() {
    return this.request<NotificationSettings>('v1/workspace/notifications')
  }
  /** Owner/admin policy update. */
  saveNotificationPolicy(body: NotificationPolicy) {
    return this.request<NotificationSettings>('v1/workspace/notifications/policy', {
      method: 'PUT',
      body,
    })
  }
  /** Update only the current member's preferences. */
  saveNotificationPreferences(body: NotificationPreferences) {
    return this.request<NotificationSettings>('v1/workspace/notifications/preferences', {
      method: 'PUT',
      body,
    })
  }
  /** Read-only inbox page. */
  notificationInbox(cursor = '', view: NotificationView = 'all') {
    return this.request<NotificationPage>(
      `v1/workspace/notifications/inbox?cursor=${encodeURIComponent(cursor)}&view=${view}`
    )
  }
  /** Read-only unseen count. */
  notificationCount() {
    return this.request<{ unseenCount: number }>('v1/workspace/notifications/count')
  }
  /** Persist read, unread, archive or restore state for the current recipient. */
  changeNotificationState(input: NotificationStateInput) {
    return this.request<NotificationStateResult>('v1/workspace/notifications/state', {
      method: 'POST',
      body: input,
    })
  }

  /** Mark receipts read while preserving their feed and archive state. */
  acknowledgeNotifications(body: { ids?: string[]; all?: boolean; key?: string }) {
    return this.request<NotificationSeen>('v1/workspace/notifications/seen', {
      method: 'POST',
      body,
    })
  }
  /** Reauthorize a link, including after its inbox row was archived. */
  resolveNotification(id: string) {
    return this.request<{ href: string }>(
      `v1/workspace/notifications/resolve/${encodeURIComponent(id)}`
    )
  }
  /** Begin backend-owned, session-bound Slack OAuth. */
  connectNotificationSlack(
    purpose: 'notifications' | 'design' | 'publishing' | 'personal' = 'notifications',
    connectionId?: string
  ) {
    return this.request<{ url: string }>('v1/workspace/notifications/slack/connect', {
      method: 'POST',
      body: { purpose, connectionId },
    })
  }
  /** Disconnect only the authenticated member's personal Slack destination. */
  disconnectPersonalSlack(id: string) {
    return this.request<{ disconnected: boolean }>(
      `v1/workspace/notifications/slack/personal/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    )
  }

  /** Consume one OAuth state and store verified provider identity in Go. */
  completeNotificationSlack(body: { state: string; code: string }) {
    return this.request<NotificationConnection>('v1/workspace/notifications/slack/callback', {
      method: 'POST',
      body,
    })
  }
  /** Read one provider cursor page. */
  notificationSlackChannels(connectionId: string, cursor = '') {
    return this.request<NotificationSlackChannels>(
      `v1/workspace/notifications/slack/channels?connectionId=${encodeURIComponent(connectionId)}&cursor=${encodeURIComponent(cursor)}`
    )
  }
  /** Disconnect only this platform workspace. */
  disconnectNotificationSlack(id: string) {
    return this.request<{ disconnected: boolean }>(
      `v1/workspace/notifications/slack/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    )
  }
  /** Request an explicitly targeted test with a stable retry key. */
  testNotification(body: { channel: 'email' | 'slack' | 'slack_dm'; key: string }) {
    return this.request<{ deliveryId: string }>('v1/workspace/notifications/test', {
      method: 'POST',
      body,
    })
  }
  /** Authorized delivery status, without retained notification content. */
  /** Inspect a personal delivery or an authorized workspace delivery. */
  notificationDelivery(id: string) {
    return this.request<NotificationDelivery>(
      `v1/workspace/notifications/deliveries/${encodeURIComponent(id)}`
    )
  }
  /** List own personal receipts or administrator-visible workspace receipts. */
  notificationDeliveries(scope: 'workspace' | 'personal' = 'workspace') {
    return this.request<{ deliveries: NotificationDelivery[] }>(
      `v1/workspace/notifications/deliveries?scope=${scope}`
    )
  }
  /** Recover one unresolved delivery; successful receipts cannot be replayed. */
  recoverNotification(id: string, action: 'retry' | 'confirm_delivered' | 'dismiss') {
    return this.request<{ recovered: boolean }>(
      `v1/workspace/notifications/deliveries/${encodeURIComponent(id)}/recover`,
      { method: 'POST', body: { action } }
    )
  }

  /** Backend-owned Slack availability. */
  slackSetup() {
    return this.request<{ ready: boolean }>('v1/integrations/slack/setup')
  }
  /** All channels visible to an authorized design connection. */
  slackDesignChannels(id: string) {
    return this.request<{ channels: NotificationSlackChannels['channels'] }>(
      `v1/integrations/${encodeURIComponent(id)}/slack/channels`
    )
  }
  /** Deliver an authorized live share link without retrieving credentials. */
  deliverSlackDesign(
    id: string,
    body: { shareLinkId: string; channelId: string; message?: string }
  ) {
    return this.request<{ label: string; url: string | null }>(
      `v1/integrations/${encodeURIComponent(id)}/slack/deliver`,
      { method: 'POST', body }
    )
  }

  async listIntegrations() {
    return this.request<{ integrations: BackendIntegration[] }>('v1/integrations')
  }

  async saveIntegration(input: {
    displayName: string
    encryptedCredentials: string
    externalId: string
    provider: IntegrationProvider
    scopes: string[]
    tokenExpiresAt: string | null
  }) {
    return this.request<BackendIntegration>('v1/integrations', { body: input, method: 'POST' })
  }

  async integrationCredentials(id: string) {
    return this.request<BackendIntegration & { encryptedCredentials: string }>(
      `v1/integrations/${encodeURIComponent(id)}/credentials`
    )
  }

  async updateIntegrationCredentials(
    id: string,
    input: { encryptedCredentials: string; tokenExpiresAt: string | null }
  ) {
    return this.request<{ updated: true }>(
      `v1/integrations/${encodeURIComponent(id)}/credentials`,
      {
        body: input,
        method: 'PUT',
      }
    )
  }

  async deleteIntegration(id: string) {
    return this.request<{ deleted: true }>(`v1/integrations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  }

  async listCreativeTemplates() {
    return this.request<{ templates: BackendCreativeTemplate[] }>('v1/creative-templates')
  }

  async createCreativeTemplate(input: { definition: unknown; name: string }) {
    return this.request<BackendCreativeTemplate>('v1/creative-templates', {
      body: input,
      method: 'POST',
    })
  }

  /** Rename every version of the template `id` belongs to. */
  async renameCreativeTemplate(id: string, name: string) {
    return this.request<BackendCreativeTemplate>(
      `v1/creative-templates/${encodeURIComponent(id)}`,
      {
        body: { name },
        method: 'PATCH',
      }
    )
  }

  /** Archive every version of the template `id` belongs to. */
  async archiveCreativeTemplate(id: string) {
    return this.request<{ archived: true }>(`v1/creative-templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  }

  async createCreativeVariant(input: {
    aspectRatio: string
    brandKitId: string
    releaseId: string
    sourceAssetId: string
    templateId: string
  }) {
    return this.request<BackendCreativeVariant>('v1/creative-variants', {
      body: input,
      method: 'POST',
    })
  }

  async decideCreativeVariant(id: string, input: { reason?: string; status: string }) {
    return this.request<{ approval: BackendCreativeApproval; variant: BackendCreativeVariant }>(
      `v1/creative-variants/${encodeURIComponent(id)}/decision`,
      { body: input, method: 'POST' }
    )
  }

  async getEntitlements() {
    return this.request<BackendEntitlementSummary>('v1/entitlements')
  }

  async getFeatureDecision(feature: string) {
    return this.request<BackendFeatureDecision>(
      `v1/entitlements/features/${encodeURIComponent(feature)}`
    )
  }

  /** Better Auth adapter operations. Service-authenticated; no principal applies. */
  async authStore(request: AuthStoreRequest) {
    return this.request<AuthStoreResult>('v1/internal/auth-store', {
      body: request,
      method: 'POST',
    })
  }

  async recordAuthEvent(event: BackendAuthEvent) {
    return this.request<{ recorded: true }>('v1/internal/auth-events', {
      body: event,
      method: 'POST',
    })
  }

  async isWorkspaceOperational(organizationId: string) {
    const result = await this.request<{ operational: boolean }>(
      `v1/internal/workspaces/${encodeURIComponent(organizationId)}/operational`
    )
    return result.operational
  }

  /**
   * Resolves when the workspace has a seat for one more member, and rejects
   * with a 403 `plan_limit_reached` when its plan's seats are full. With
   * `invitations`, pending invitations count as held seats.
   */
  async requireWorkspaceSeat(organizationId: string, invitations: boolean) {
    await this.request<{ available: true }>(
      `v1/internal/workspaces/${encodeURIComponent(organizationId)}/seat?invitations=${invitations}`
    )
  }

  async appendAuditEvent(event: BackendAuditEvent) {
    return this.request<{ recorded: true }>('v1/audit-events', { body: event, method: 'POST' })
  }

  /** Global screenshot cache. Service-authenticated; no principal applies. */
  async getScreenshotCache(urlHash: string) {
    return this.request<BackendScreenshotCacheEntry>(
      `v1/internal/screenshot-cache/${encodeURIComponent(urlHash)}`
    )
  }

  async getScreenshotCacheObject(urlHash: string) {
    return this.request<{ base64: string }>(
      `v1/internal/screenshot-cache/${encodeURIComponent(urlHash)}/object`
    )
  }

  async putScreenshotCacheObject(urlHash: string, body: Uint8Array) {
    return this.request<{ stored: true }>(
      `v1/internal/screenshot-cache/${encodeURIComponent(urlHash)}/object`,
      {
        headers: { 'content-type': 'image/png' },
        method: 'PUT',
        rawBody: new Uint8Array(body).buffer,
      }
    )
  }

  async putScreenshotCache(
    urlHash: string,
    input: { cloudinaryPublicId: string; cloudinaryUrl: string; url: string }
  ) {
    return this.request<BackendScreenshotCacheEntry>(
      `v1/internal/screenshot-cache/${encodeURIComponent(urlHash)}`,
      { body: input, method: 'PUT' }
    )
  }

  async deleteScreenshotCache(urlHash: string) {
    return this.request<{ deleted: true }>(
      `v1/internal/screenshot-cache/${encodeURIComponent(urlHash)}`,
      { method: 'DELETE' }
    )
  }

  async listScreenshotCache(filter: BackendScreenshotCacheFilter) {
    return this.request<{ entries: BackendScreenshotCacheEntry[] }>(
      'v1/internal/screenshot-cache/query',
      { body: filter, method: 'POST' }
    )
  }

  async purgeScreenshotCache(filter: BackendScreenshotCacheFilter) {
    return this.request<{ deleted: number }>('v1/internal/screenshot-cache/purge', {
      body: filter,
      method: 'POST',
    })
  }

  /** The workspace's assets in any status, by id or by object key. */
  async findAssets(query: { ids: string[] } | { objectKey: string }) {
    const parameters = new URLSearchParams(
      'ids' in query ? query.ids.map((id) => ['id', id]) : [['objectKey', query.objectKey]]
    )
    return this.request<{ assets: BackendRenderAsset[] }>(`v1/assets/lookup?${parameters}`)
  }

  /** The image of the newest workspace design rendered under this key. */
  async findDesignRender(renderKey: string) {
    return this.request<BackendRenderAsset>(`v1/design-renders/${encodeURIComponent(renderKey)}`)
  }

  async listAnnouncements(limit: number) {
    return this.request<{ announcements: BackendAnnouncementListItem[] }>(
      `v1/announcements?limit=${limit}`
    )
  }

  async scheduleAnnouncement(input: BackendScheduleAnnouncementInput) {
    return this.request<{ announcement: BackendAnnouncement; created: boolean }>(
      'v1/announcements',
      { body: input, method: 'POST' }
    )
  }

  async cancelAnnouncement(id: string) {
    return this.request<{ cancelled: boolean }>(
      `v1/announcements/${encodeURIComponent(id)}/cancel`,
      { method: 'POST' }
    )
  }

  async getAudienceReach() {
    return this.request<{ reach: number }>('v1/audience/reach')
  }

  async listAudienceSubscribers(options: { includeUnsubscribed: boolean; limit: number }) {
    return this.request<{ subscribers: BackendAudienceSubscriber[] }>(
      `v1/audience/subscribers?limit=${options.limit}&includeUnsubscribed=${options.includeUnsubscribed}`
    )
  }

  async addAudienceSubscribers(subscribers: { email: string; name?: string }[]) {
    return this.request<{ added: number; skipped: number }>('v1/audience/subscribers', {
      body: { subscribers },
      method: 'POST',
    })
  }

  /** Records a verified one-click opt-out; requires a service scope. */
  async unsubscribeAudienceMember(email: string) {
    return this.request<{ unsubscribed: boolean }>('v1/audience/unsubscribe', {
      body: { email },
      method: 'POST',
    })
  }

  async listAuditDrains() {
    return this.request<{ drains: BackendAuditDrain[] }>('v1/audit-drains')
  }

  async createAuditDrain(input: BackendAuditDrainInput, audit?: BackendAuditRequest) {
    return this.request<{ drain: BackendAuditDrain }>('v1/audit-drains', {
      body: input,
      headers: auditRequestHeaders(audit),
      method: 'POST',
    })
  }

  async deleteAuditDrain(id: string, audit?: BackendAuditRequest) {
    return this.request<{ deleted: true }>(`v1/audit-drains/${encodeURIComponent(id)}`, {
      headers: auditRequestHeaders(audit),
      method: 'DELETE',
    })
  }

  async getAuditRetention() {
    return this.request<BackendAuditRetention>('v1/audit-retention')
  }

  async updateAuditRetention(input: BackendAuditRetention, audit?: BackendAuditRequest) {
    return this.request<BackendAuditRetention>('v1/audit-retention', {
      body: input,
      headers: auditRequestHeaders(audit),
      method: 'PUT',
    })
  }

  async listPermissionGroups() {
    return this.request<{ groups: BackendPermissionGroup[] }>('v1/permission-groups')
  }

  async createPermissionGroup(input: BackendPermissionGroupInput, audit?: BackendAuditRequest) {
    return this.request<BackendPermissionGroup>('v1/permission-groups', {
      body: input,
      headers: auditRequestHeaders(audit),
      method: 'POST',
    })
  }

  async updatePermissionGroup(
    id: string,
    input: BackendPermissionGroupInput,
    audit?: BackendAuditRequest
  ) {
    return this.request<BackendPermissionGroup>(`v1/permission-groups/${encodeURIComponent(id)}`, {
      body: input,
      headers: auditRequestHeaders(audit),
      method: 'PUT',
    })
  }

  async deletePermissionGroup(id: string, audit?: BackendAuditRequest) {
    return this.request<{ deleted: boolean }>(`v1/permission-groups/${encodeURIComponent(id)}`, {
      headers: auditRequestHeaders(audit),
      method: 'DELETE',
    })
  }

  async setPermissionGroupMembers(id: string, memberIds: string[], audit?: BackendAuditRequest) {
    return this.request<BackendPermissionGroup>(
      `v1/permission-groups/${encodeURIComponent(id)}/members`,
      { body: { memberIds }, headers: auditRequestHeaders(audit), method: 'PUT' }
    )
  }

  async getWhitelabel() {
    return this.request<BackendWhitelabelSettings>('v1/whitelabel')
  }

  async updateWhitelabel(input: BackendWhitelabelSettings, audit?: BackendAuditRequest) {
    return this.request<BackendWhitelabelSettings>('v1/whitelabel', {
      body: input,
      headers: auditRequestHeaders(audit),
      method: 'PUT',
    })
  }

  /** Facade-only: resolves a source app before its webhook signature is verified. */
  async getWebhookSource(sourceAppId: string) {
    return this.request<BackendWebhookSource>(
      `v1/internal/source-apps/${encodeURIComponent(sourceAppId)}/webhook`
    )
  }

  async ingestSourceRelease(input: BackendSourceReleaseInput) {
    return this.request<{ created: boolean; releaseId: string }>('v1/source-releases', {
      body: input,
      method: 'POST',
    })
  }

  async collectSourceChange(input: BackendSourceChangeInput) {
    return this.request<{ changeId: string; created: boolean }>('v1/source-changes', {
      body: input,
      method: 'POST',
    })
  }

  async ingestDeployment(input: BackendDeploymentInput) {
    return this.request<{ created: boolean; deploymentId: string }>('v1/source-deployments', {
      body: input,
      method: 'POST',
    })
  }

  /** List backend-verified production sources without credentials. */
  async frontendSources() {
    return z
      .object({ sources: z.array(frontendSourceSchema) })
      .parse(await this.request<unknown>('v1/frontend-sources'))
  }
  /** Save an opt-in production policy with optimistic concurrency. */
  async saveFrontendSource(input: FrontendSourceInput) {
    return frontendSourceSchema.parse(
      await this.request<unknown>('v1/frontend-sources', { method: 'PUT', body: input })
    )
  }
  /** Read this workspace's immutable deployment evidence and decisions. */
  async frontendHistory(id: string) {
    return z
      .object({ items: z.array(frontendEvidenceSchema) })
      .parse(await this.request<unknown>(`v1/frontend-sources/${encodeURIComponent(id)}/history`))
  }
  /** Preview the same evaluator used by durable acceptance, without side effects. */
  async previewFrontend(input: z.infer<typeof frontendPreviewSchema>) {
    return frontendDecisionSchema.parse(
      await this.request<unknown>('v1/frontend-sources/preview', { method: 'POST', body: input })
    )
  }
  /** Forward unmodified body text; the backend verifies the provider signature. */
  async metaDataCallback(provider: string, signedRequest: string) {
    return z.object({ url: z.string().url(), confirmation_code: z.string().min(1) }).parse(
      await this.request<unknown>(`v1/internal/meta-callbacks/${encodeURIComponent(provider)}`, {
        method: 'POST',
        body: { signedRequest },
      })
    )
  }

  async acceptFrontendWebhook(id: string, signature: string, body: string) {
    return z.object({ accepted: z.literal(true) }).parse(
      await this.request<unknown>(`v1/internal/frontend-webhooks/${encodeURIComponent(id)}`, {
        method: 'POST',
        body: { signature, body },
      })
    )
  }

  /** Begins connecting a GitHub App installation; the state is single-use. */
  async startGitHubConnection() {
    return this.request<{ state: string }>('v1/github/connections/start', { method: 'POST' })
  }

  /** Durably accept a signature-verified App event and its tenant fan-out. */
  async acceptGitHubEvent(input: { deliveryId: string; eventName: string; body: unknown }) {
    return this.request<{ handled: number; duplicates: number }>('v1/internal/github/events', {
      method: 'POST',
      body: input,
    })
  }

  /** Connections, definitions, resources, and executor capability for this workspace. */
  async releaseAutomationOverview() {
    return this.request<AutomationOverview>('v1/release-automation')
  }

  /** Save a draft with optimistic concurrency; incomplete graphs remain drafts. */
  async getGitHubProduction(id: string, cursor = '') {
    return githubProductionStateSchema.parse(
      await this.request<unknown>(
        `v1/github/sources/${encodeURIComponent(id)}/production?cursor=${encodeURIComponent(cursor)}`
      )
    )
  }
  async saveGitHubProduction(id: string, input: z.infer<typeof saveGitHubProductionSchema>) {
    return githubPolicyVersionSchema.parse(
      await this.request<unknown>(`v1/github/sources/${encodeURIComponent(id)}/production`, {
        body: input,
        method: 'PUT',
      })
    )
  }
  async previewGitHubProduction(id: string, input: z.infer<typeof previewGitHubProductionSchema>) {
    return githubProductionDecisionSchema.parse(
      await this.request<unknown>(
        `v1/github/sources/${encodeURIComponent(id)}/production-preview`,
        { body: input, method: 'POST' }
      )
    )
  }
  async getGitHubProductionCatalog(id: string, runId = 0, attempt = 0) {
    return githubProductionCatalogSchema.parse(
      await this.request<unknown>(
        `v1/github/sources/${encodeURIComponent(id)}/production-catalog?runId=${runId}&attempt=${attempt}`
      )
    )
  }
  async getGitHubRecovery(id: string) {
    return githubRecoverySchema.parse(
      await this.request<unknown>(`v1/github/sources/${encodeURIComponent(id)}/delivery-recovery`)
    )
  }
  async inspectGitHubRecovery(id: string, redeliver: boolean) {
    return githubRecoverySchema.parse(
      await this.request<unknown>(`v1/github/sources/${encodeURIComponent(id)}/delivery-recovery`, {
        body: { redeliver },
        method: 'POST',
      })
    )
  }
  async saveReleaseAutomation(input: SaveAutomationInput) {
    return this.request<AutomationDefinition>('v1/release-automation', {
      method: 'PUT',
      body: input,
    })
  }

  /** Activate an immutable server-validated graph version. */
  async activateReleaseAutomation(id: string, revision: number) {
    return this.request<AutomationDefinition>(
      `v1/release-automation/${encodeURIComponent(id)}/activation`,
      { method: 'POST', body: { revision } }
    )
  }

  /** Archive or restore a definition, retaining immutable versions and runs. */
  async archiveReleaseAutomation(id: string, revision: number, archived: boolean) {
    return this.request<{ archived: boolean }>(
      `v1/release-automation/${encodeURIComponent(id)}/archive`,
      { method: 'PUT', body: { revision, archived } }
    )
  }

  /** Stop new executions and request cancellation without restoring legacy intake. */
  async disableReleaseAutomation(id: string, revision: number) {
    return this.request<{ disabled: boolean }>(
      `v1/release-automation/${encodeURIComponent(id)}/disable`,
      { method: 'POST', body: { revision } }
    )
  }

  /** Explicitly select automation or legacy intake, and the watched branch, for one source. */
  async setReleaseAutomationMode(
    id: string,
    enabled: boolean,
    collectUnmatched?: boolean,
    branch?: string
  ) {
    return this.request<{ updated: boolean }>(
      `v1/release-automation/sources/${encodeURIComponent(id)}/mode`,
      { method: 'PUT', body: { enabled, collectUnmatched, branch } }
    )
  }

  /** Predict against an example or stored event; no side effects or external reads. */
  async previewReleaseAutomation(input: {
    sourceAppId: string
    graph: AutomationGraph
    eventId?: string
    example?: AutomationEventSnapshot
    assumeIrrelevant?: boolean
  }) {
    return this.request<AutomationPreview>('v1/release-automation/preview', {
      method: 'POST',
      body: input,
    })
  }

  /** Stop this workspace's source without changing the shared GitHub installation. */
  async disconnectReleaseAutomationSource(id: string) {
    return this.request<{ disconnected: boolean }>(
      `v1/release-automation/sources/${encodeURIComponent(id)}/disconnect`,
      { method: 'POST' }
    )
  }

  /** Read durable tenant history even while Temporal is unavailable. */
  async listReleaseAutomationHistory(filter: AutomationHistoryFilter = {}) {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(filter)) if (value) query.set(key, value)
    return this.request<{ items: AutomationHistoryItem[] }>(`v1/release-automation/runs?${query}`)
  }

  /** Read small run summaries; full evidence is available from the run detail endpoint. */
  async listReleaseAutomationRunSummaries(filter: AutomationHistoryFilter = {}, limit = 50) {
    const query = new URLSearchParams({ summary: 'true', limit: String(limit) })
    for (const [key, value] of Object.entries(filter)) if (value) query.set(key, value)
    return this.request<{ items: AutomationRunSummary[] }>(`v1/release-automation/runs?${query}`)
  }

  /** List a definition's immutable activated versions, newest first. */
  async listReleaseAutomationVersions(definitionId: string) {
    return this.request<{ items: AutomationVersion[] }>(
      `v1/release-automation/definitions/${encodeURIComponent(definitionId)}/versions`
    )
  }

  /** Read persisted node decisions, attempts, and product output references. */
  async getReleaseAutomationRun(id: string) {
    return this.request<AutomationRunDetail>(`v1/release-automation/runs/${encodeURIComponent(id)}`)
  }

  /** Read the pinned immutable version used by an execution. */
  async getReleaseAutomationVersion(id: string) {
    return this.request<AutomationVersion>(
      `v1/release-automation/versions/${encodeURIComponent(id)}`
    )
  }

  /** Request cancellation; already completed provider effects are not reversed. */
  async cancelReleaseAutomationRun(id: string) {
    return this.request<{ requested: boolean }>(
      `v1/release-automation/runs/${encodeURIComponent(id)}/cancel`,
      { method: 'POST' }
    )
  }

  /** Resume eligible failed work with its original version and action identities. */
  async retryReleaseAutomationRun(id: string) {
    return this.request<{ requested: boolean }>(
      `v1/release-automation/runs/${encodeURIComponent(id)}/retry`,
      { method: 'POST' }
    )
  }

  /** This workspace's connections, recipes and recent jobs; any member may read them. */
  async captureOverview() {
    return this.request<CaptureOverview>('v1/capture')
  }

  async createCaptureConnection(input: CaptureConnectionInput) {
    return this.request<{ connection: CaptureConnection }>('v1/capture/connections', {
      body: input,
      method: 'POST',
    })
  }

  /** Opens a sign-in browser for an owner or admin session; see {@link CaptureConnectStart}. */
  async startCaptureConnect(id: string) {
    return this.request<CaptureConnectStart>(
      `v1/capture/connections/${encodeURIComponent(id)}/connect`,
      { method: 'POST' }
    )
  }

  /** Records "I signed in"; the worker must still restore it in a fresh browser. */
  async finishCaptureConnect(id: string, intentId: string) {
    return this.request<{ accepted: true }>(
      `v1/capture/connections/${encodeURIComponent(id)}/connect/finish`,
      { body: { intentId }, method: 'POST' }
    )
  }

  async revokeCaptureConnection(id: string) {
    return this.request<{ revoked: true }>(
      `v1/capture/connections/${encodeURIComponent(id)}/revoke`,
      { method: 'POST' }
    )
  }

  async createCaptureRecipe(input: CaptureRecipeInput) {
    return this.request<{ recipe: CaptureRecipe }>('v1/capture/recipes', {
      body: input,
      method: 'POST',
    })
  }

  /** Enables capture after deployment for a tested version, replacing any earlier one. */
  async activateCaptureRecipe(id: string) {
    return this.request<{ recipe: CaptureRecipe }>(
      `v1/capture/recipes/${encodeURIComponent(id)}/activate`,
      { method: 'POST' }
    )
  }

  async archiveCaptureRecipe(id: string) {
    return this.request<{ archived: true }>(
      `v1/capture/recipes/${encodeURIComponent(id)}/archive`,
      { method: 'POST' }
    )
  }

  /** Runs a recipe now: a test may use a draft; anything else needs an active recipe. */
  async requestCaptureJob(
    recipeId: string,
    input: { test: boolean; source?: 'agent' | 'manual'; sourceId?: string }
  ) {
    return this.request<{ job: CaptureJob }>(
      `v1/capture/recipes/${encodeURIComponent(recipeId)}/jobs`,
      { body: input, method: 'POST' }
    )
  }

  async cancelCaptureJob(id: string) {
    return this.request<{ cancelled: true }>(`v1/capture/jobs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    })
  }

  async completeGitHubConnection(input: { code: string; installationId: number; state: string }) {
    return this.request<GitHubConnection>('v1/github/connections/complete', {
      body: input,
      method: 'POST',
    })
  }

  async listGitHubConnections() {
    return this.request<{ connections: GitHubConnection[] }>('v1/github/connections')
  }

  async deleteGitHubConnection(connectionId: string) {
    return this.request<{ deleted: true }>(
      `v1/github/connections/${encodeURIComponent(connectionId)}`,
      { method: 'DELETE' }
    )
  }

  async listGitHubRepositories(connectionId: string) {
    return this.request<{ repositories: GitHubRepository[] }>(
      `v1/github/connections/${encodeURIComponent(connectionId)}/repositories`
    )
  }

  /** Facade-only: every workspace's source for a repository an installation delivers. */
  async getGitHubSources(installationId: number, repositoryId: number) {
    return this.request<{ sources: BackendWebhookSource[] }>(
      `v1/internal/github/installations/${installationId}/repositories/${repositoryId}/sources`
    )
  }

  /** Facade-only: records an installation from GitHub's lifecycle events. */
  async recordGitHubInstallation(installationId: number, input: GitHubInstallationRecord) {
    return this.request<{ recorded: true }>(`v1/internal/github/installations/${installationId}`, {
      body: input,
      method: 'PUT',
    })
  }

  /** Facade-only: records a suspension, resumption, or removal. */
  async setGitHubInstallationStatus(
    installationId: number,
    status: 'ACTIVE' | 'SUSPENDED' | 'DELETED'
  ) {
    return this.request<{ archived: number }>(
      `v1/internal/github/installations/${installationId}/status`,
      { body: { status }, method: 'POST' }
    )
  }

  /** Facade-only: archives sources for repositories an installation lost. */
  async removeGitHubRepositories(installationId: number, repositoryIds: string[]) {
    return this.request<{ archived: number }>(
      `v1/internal/github/installations/${installationId}/removed-repositories`,
      { body: { repositoryIds }, method: 'POST' }
    )
  }

  /** Facade-only: returns a dead-lettered outbox event to the queue. */
  async replayOutboxEvent(eventId: string) {
    return this.request<{ replayed: true }>(
      `v1/internal/outbox-events/${encodeURIComponent(eventId)}/replay`,
      { method: 'POST' }
    )
  }

  /** Facade-only: applies a billing event once, at the version it expects. */
  async syncWorkspaceEntitlement(input: BackendEntitlementSync) {
    return this.request<{ replayed: boolean; version: number }>(
      'v1/internal/billing/entitlements',
      { body: input, method: 'POST' }
    )
  }

  /** Facade-only: adds a paid AI credit pack once per provider reference. */
  async grantWorkspaceCredits(input: BackendCreditGrant) {
    return this.request<{ balance: number; replayed: boolean }>(
      'v1/internal/billing/credit-grants',
      { body: input, method: 'POST' }
    )
  }

  /** The owner's contract view; requires a fresh two-factor session. */
  async getWorkspaceEntitlement() {
    return this.request<{ entitlement: BackendWorkspaceEntitlement }>('v1/entitlements/contract')
  }

  async getLaunchCampaign(campaignId: string) {
    return this.request<BackendLaunchCampaign>(
      `v1/launch/campaigns/${encodeURIComponent(campaignId)}`
    )
  }

  /** The active kit, the brand profile and the workspace voice (the brand's WritingContext). */
  async getLaunchBrand() {
    return this.request<{
      kit: BrandKit | null
      profile: BrandProfile | null
      voice?: WritingContext | null
    }>('v1/launch/brand')
  }

  async getLaunchPreferences() {
    return this.request<BackendLaunchPreferences>('v1/launch/preferences')
  }

  async listLaunchSpecs(releaseId: string) {
    return this.request<{ specs: BackendLaunchSpec[] }>(
      `v1/launch/releases/${encodeURIComponent(releaseId)}/specs`
    )
  }

  async getLaunchSpec(specId: string) {
    return this.request<BackendLaunchSpec>(`v1/launch/specs/${encodeURIComponent(specId)}`)
  }

  async saveLaunchSpec(
    releaseId: string,
    input: BackendLaunchVersionInput & { sources: unknown[] }
  ) {
    return this.request<BackendLaunchSpec>(
      `v1/launch/releases/${encodeURIComponent(releaseId)}/specs`,
      { body: input, method: 'POST' }
    )
  }

  async approveLaunchSpec(specId: string) {
    return this.request<BackendLaunchSpec>(
      `v1/launch/specs/${encodeURIComponent(specId)}/approve`,
      { method: 'POST' }
    )
  }

  async listLaunchPlans(campaignId: string) {
    return this.request<{ plans: BackendLaunchPlan[] }>(
      `v1/launch/campaigns/${encodeURIComponent(campaignId)}/plans`
    )
  }

  async getLaunchPlan(campaignId: string, planId: string) {
    return this.request<BackendLaunchPlan>(
      `v1/launch/campaigns/${encodeURIComponent(campaignId)}/plans/${encodeURIComponent(planId)}`
    )
  }

  async saveLaunchPlan(
    campaignId: string,
    input: BackendLaunchVersionInput & { specId: string | null }
  ) {
    return this.request<BackendLaunchPlan>(
      `v1/launch/campaigns/${encodeURIComponent(campaignId)}/plans`,
      { body: input, method: 'POST' }
    )
  }

  async approveLaunchPlan(planId: string) {
    return this.request<BackendLaunchPlan>(
      `v1/launch/plans/${encodeURIComponent(planId)}/approve`,
      { method: 'POST' }
    )
  }

  async saveLaunchPosts(campaignId: string, input: BackendLaunchPostsInput) {
    return this.request<{ angleCount: number; postCount: number }>(
      `v1/launch/campaigns/${encodeURIComponent(campaignId)}/posts`,
      { body: input, method: 'POST' }
    )
  }

  async listLaunchRevisions(campaignId: string) {
    return this.request<{ revisions: BackendLaunchRevision[] }>(
      `v1/launch/campaigns/${encodeURIComponent(campaignId)}/revisions`
    )
  }

  async createLaunchRevision(
    campaignId: string,
    input: { comment: string; modelId: string | null; proposal: unknown }
  ) {
    return this.request<BackendLaunchRevision>(
      `v1/launch/campaigns/${encodeURIComponent(campaignId)}/revisions`,
      { body: input, method: 'POST' }
    )
  }

  async getLaunchRevision(revisionId: string) {
    return this.request<BackendLaunchRevision>(
      `v1/launch/revisions/${encodeURIComponent(revisionId)}`
    )
  }

  /** Apply a proposal; design changes carry the patched document by design id. */
  async applyLaunchRevision(
    revisionId: string,
    input: { designDocuments: Record<string, unknown>; related: number[] }
  ) {
    return this.request<{ designIds: string[]; revision: BackendLaunchRevision }>(
      `v1/launch/revisions/${encodeURIComponent(revisionId)}/apply`,
      { body: input, method: 'POST' }
    )
  }

  async discardLaunchRevision(revisionId: string) {
    return this.request<BackendLaunchRevision>(
      `v1/launch/revisions/${encodeURIComponent(revisionId)}/discard`,
      { method: 'POST' }
    )
  }

  async setLaunchDesignCritique(designId: string, critique: Record<string, unknown>) {
    return this.request<{ updated: true }>(
      `v1/launch/designs/${encodeURIComponent(designId)}/critique`,
      { body: { critique }, method: 'PUT' }
    )
  }

  async listLaunchRuns(campaignId: string) {
    return this.request<{ runs: BackendLaunchRun[] }>(
      `v1/launch/campaigns/${encodeURIComponent(campaignId)}/runs`
    )
  }

  async startLaunchRun(campaignId: string, kind: string) {
    return this.request<BackendLaunchRun>(
      `v1/launch/campaigns/${encodeURIComponent(campaignId)}/runs`,
      { body: { kind }, method: 'POST' }
    )
  }

  async getLaunchRun(runId: string) {
    return this.request<BackendLaunchRun>(`v1/launch/runs/${encodeURIComponent(runId)}`)
  }

  /** Ends a running run. The counters are an agent run's totals; omitted ones are kept. */
  async finishLaunchRun(
    runId: string,
    input: {
      costCents?: number
      error?: string
      resultId?: string | null
      status: 'BUDGET_EXHAUSTED' | 'FAILED' | 'SUCCEEDED'
      stepCount?: number
      summary?: string | null
      tokensIn?: number
      tokensOut?: number
    }
  ) {
    return this.request<{ updated: true }>(`v1/launch/runs/${encodeURIComponent(runId)}/finish`, {
      body: input,
      method: 'POST',
    })
  }

  /** Keeps a run's lease; `running` is false once the run was cancelled or expired. */
  async heartbeatLaunchRun(runId: string) {
    return this.request<{ running: boolean }>(
      `v1/launch/runs/${encodeURIComponent(runId)}/heartbeat`,
      { method: 'POST' }
    )
  }

  /** Agent runs end CANCELLED; pipeline runs end FAILED with "Cancelled.". */
  async cancelLaunchRun(runId: string) {
    return this.request<{ cancelled: boolean }>(
      `v1/launch/runs/${encodeURIComponent(runId)}/cancel`,
      { method: 'POST' }
    )
  }

  /**
   * Starts an agent or conversation run, optionally about a campaign. Any
   * member starts a conversation run; an agent run needs owner, admin, or
   * creator. Answers 403 when the workspace turned AI off. The member who
   * started a conversation run may append its steps, heartbeat, finish, and
   * cancel it.
   */
  async startAgentRun(input: { campaignId?: string | null; kind: 'agent' | 'conversation' }) {
    return this.request<BackendAgentRun>('v1/launch/runs', { body: input, method: 'POST' })
  }

  async getAgentRun(runId: string) {
    return this.request<BackendAgentRun>(`v1/launch/runs/${encodeURIComponent(runId)}`)
  }

  async appendLaunchRunStep(runId: string, input: BackendLaunchRunStepInput) {
    return this.request<BackendLaunchRunStep>(`v1/launch/runs/${encodeURIComponent(runId)}/steps`, {
      body: input,
      method: 'POST',
    })
  }

  /** A run's trace in step order, up to 500 steps. */
  async listLaunchRunSteps(runId: string) {
    return this.request<{ steps: BackendLaunchRunStep[] }>(
      `v1/launch/runs/${encodeURIComponent(runId)}/steps`
    )
  }

  /** Any member starts a conversation; an empty title becomes "New conversation". */
  async createConversation(input: { campaignId?: string | null; title?: string }) {
    return this.request<BackendConversation>('v1/conversations', { body: input, method: 'POST' })
  }

  /** Most recently active first; status defaults to ACTIVE, limit to 20 (at most 100). */
  async listConversations(
    options: { campaignId?: string; limit?: number; status?: 'ACTIVE' | 'ARCHIVED' } = {}
  ) {
    const parameters = new URLSearchParams()
    if (options.campaignId) parameters.set('campaignId', options.campaignId)
    if (options.limit !== undefined) parameters.set('limit', String(options.limit))
    if (options.status) parameters.set('status', options.status)
    return this.request<{ conversations: BackendConversation[] }>(`v1/conversations?${parameters}`)
  }

  /** A conversation with its 200 newest messages, oldest first. */
  async getConversation(conversationId: string) {
    return this.request<{
      conversation: BackendConversation
      messages: BackendConversationMessage[]
    }>(`v1/conversations/${encodeURIComponent(conversationId)}`)
  }

  /** Answers 409 for an archived conversation. */
  async appendConversationMessage(conversationId: string, input: BackendConversationMessageInput) {
    return this.request<BackendConversationMessage>(
      `v1/conversations/${encodeURIComponent(conversationId)}/messages`,
      { body: input, method: 'POST' }
    )
  }

  async updateConversation(conversationId: string, input: BackendConversationUpdate) {
    return this.request<BackendConversation>(
      `v1/conversations/${encodeURIComponent(conversationId)}`,
      { body: input, method: 'PATCH' }
    )
  }

  async getCampaignAsset(campaignId: string, assetId: string) {
    return this.request<BackendCampaignAssetLink>(
      `v1/campaigns/${encodeURIComponent(campaignId)}/assets/${encodeURIComponent(assetId)}`
    )
  }

  async linkCampaignAsset(
    campaignId: string,
    assetId: string,
    input: BackendLinkCampaignAssetInput
  ) {
    return this.request<BackendCampaignAssetLink>(
      `v1/campaigns/${encodeURIComponent(campaignId)}/assets/${encodeURIComponent(assetId)}`,
      { body: input, method: 'PUT' }
    )
  }

  /** Append generated angles and draft posts to a campaign. */
  async saveCampaignCopy(
    campaignId: string,
    input: Pick<BackendCreateCampaignInput, 'angles' | 'posts'>
  ) {
    return this.request<{ angleCount: number; postCount: number }>(
      `v1/campaigns/${encodeURIComponent(campaignId)}/copy`,
      { body: input, method: 'POST' }
    )
  }

  /** Edit a design in place; name and variant label change only when given. */
  async replaceDesign(
    id: string,
    input: { document: unknown; name?: string; variantLabel?: string }
  ) {
    return this.request<{ updated: true }>(`v1/designs/${encodeURIComponent(id)}`, {
      body: input,
      method: 'PUT',
    })
  }

  /** Current session workspace and page entitlements, without dashboard counters. */
  async getPageAccess() {
    return this.request<{
      active: ListedWorkspace | null
      count: number
      deniedPermissions?: string[]
      workspace: Workspace | null
      features: Record<string, boolean>
      whitelabel: BackendWhitelabelSettings | null
    }>('v1/page-access')
  }

  async getBootstrap() {
    return this.request<BackendBootstrapSnapshot>('v1/bootstrap')
  }

  async listAuditLogs(
    query: AuditLogQuery,
    audit?: { ipHash?: string; userAgentSummary?: string }
  ) {
    const parameters = new URLSearchParams()
    if (query.action) parameters.set('action', query.action)
    if (query.actorUserId) parameters.set('actorUserId', query.actorUserId)
    if (query.cursor) parameters.set('cursor', query.cursor)
    if (query.endDate) parameters.set('endDate', query.endDate.toISOString())
    if (query.entityType) parameters.set('entityType', query.entityType)
    if (query.limit !== undefined) parameters.set('limit', String(query.limit))
    if (query.outcome) parameters.set('outcome', query.outcome)
    if (query.search) parameters.set('search', query.search)
    if (query.startDate) parameters.set('startDate', query.startDate.toISOString())
    return this.request<AuditLogPage>(`v1/audit-logs?${parameters}`, {
      headers: {
        ...(audit?.ipHash ? { 'x-audit-ip-hash': audit.ipHash } : {}),
        ...(audit?.userAgentSummary
          ? { 'x-audit-user-agent-summary': audit.userAgentSummary }
          : {}),
      },
    })
  }

  async setActiveWorkspace(organizationId: string) {
    return this.request<{ updated: true }>('v1/workspaces/active', {
      body: { organizationId },
      method: 'POST',
    })
  }

  async getWorkspace() {
    return this.request<{ workspace: Workspace | null }>('v1/workspace')
  }

  async updateWorkspace(input: UpdateWorkspaceInput) {
    return this.request<WorkspaceMutation>('v1/workspace', { body: input, method: 'PATCH' })
  }

  async listWorkspaceMembers() {
    return workspaceMembersSchema.parse(await this.request('v1/workspace/members'))
  }

  async listWorkspaceInvitations() {
    return this.request<{ invitations: WorkspaceInvitation[] }>('v1/workspace/invitations')
  }

  async inviteWorkspaceMember(input: { email: string; role: string }) {
    return workspaceInvitationDetailSchema.parse(
      await this.request('v1/workspace/invitations', {
        body: input,
        method: 'POST',
      })
    )
  }

  async resendWorkspaceInvitation(invitationId: string) {
    return workspaceInvitationDetailSchema.parse(
      await this.request(`v1/workspace/invitations/${encodeURIComponent(invitationId)}/resend`, {
        method: 'POST',
      })
    )
  }

  /** Read a link only as its currently authenticated recipient. */
  async getRecipientInvitation(invitationId: string) {
    return recipientInvitationSchema.parse(
      await this.request(`v1/invitations/${encodeURIComponent(invitationId)}`)
    )
  }

  /** Consume a pending invitation with membership, seats and audit in one transaction. */
  async respondWorkspaceInvitation(invitationId: string, action: 'accept' | 'reject') {
    return invitationResponseSchema.parse(
      await this.request(`v1/invitations/${encodeURIComponent(invitationId)}/respond`, {
        method: 'POST',
        body: { action },
      })
    )
  }

  /** Administrative cancellation using the same operation as the workspace controls. */
  async cancelWorkspaceInvitation(invitationId: string) {
    return recipientInvitationSchema.parse(
      await this.request(`v1/workspace/invitations/${encodeURIComponent(invitationId)}`, {
        method: 'DELETE',
      })
    )
  }

  async revokeWorkspaceInvitation(invitationId: string) {
    return this.request<{ id: string; status: 'canceled' }>(
      `v1/workspace/invitations/${encodeURIComponent(invitationId)}`,
      { method: 'DELETE' }
    )
  }

  async updateWorkspaceMemberRole(memberId: string, role: string) {
    return workspaceMemberSchema.parse(
      await this.request(`v1/workspace/members/${encodeURIComponent(memberId)}`, {
        body: { role },
        method: 'PATCH',
      })
    )
  }

  async removeWorkspaceMember(memberId: string) {
    return workspaceMemberRemovalSchema.parse(
      await this.request(`v1/workspace/members/${encodeURIComponent(memberId)}`, {
        method: 'DELETE',
      })
    )
  }

  async leaveWorkspace() {
    return workspaceMemberLeaveSchema.parse(
      await this.request('v1/workspace/leave', { method: 'POST' })
    )
  }

  async transferWorkspaceOwnership(memberId: string) {
    return this.request<{ transferred: true }>('v1/workspace/transfer-ownership', {
      body: { memberId },
      method: 'POST',
    })
  }

  async requestWorkspaceDeletion(confirmation: string) {
    return this.request<WorkspaceDeletion>('v1/workspace/deletion', {
      body: { confirmation },
      method: 'POST',
    })
  }

  async cancelWorkspaceDeletion() {
    return this.request<WorkspaceDeletion>('v1/workspaces/deletion/cancel', { method: 'POST' })
  }

  async createStoreReview(input: {
    projectId: string
    name: string
    versionLabel: string
    projectRevision: number
    slides: BackendStoreReviewSlide[]
  }) {
    return this.request<BackendStoreReview>('v1/store-reviews', { body: input, method: 'POST' })
  }

  async listStoreReviews(projectId: string) {
    return this.request<{ reviews: BackendStoreReview[] }>(
      `v1/store-reviews?projectId=${encodeURIComponent(projectId)}`
    )
  }

  async getStoreReview(id: string) {
    return this.request<BackendStoreReview>(`v1/store-reviews/${encodeURIComponent(id)}`)
  }

  /** Read a review through its share link; service principals only. */
  async getSharedStoreReview(id: string, shareTokenId: string) {
    return this.request<BackendStoreReview>(`v1/store-reviews/${encodeURIComponent(id)}/shared`, {
      headers: { 'x-share-token-id': shareTokenId },
    })
  }

  async revokeStoreReview(id: string) {
    return this.request<{ revoked: boolean }>(`v1/store-reviews/${encodeURIComponent(id)}/revoke`, {
      method: 'POST',
    })
  }

  async addStoreReviewComment(
    id: string,
    input: {
      slideId: string
      x: number | null
      y: number | null
      authorName: string
      body: string
    },
    shareTokenId?: string
  ) {
    return this.request<BackendStoreReviewComment>(
      `v1/store-reviews/${encodeURIComponent(id)}/comments`,
      {
        body: input,
        headers: shareTokenId ? { 'x-share-token-id': shareTokenId } : {},
        method: 'POST',
      }
    )
  }

  async resolveStoreReviewComment(id: string, commentId: string, resolved: boolean) {
    return this.request<{ resolved: boolean }>(
      `v1/store-reviews/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}/resolution`,
      { body: { resolved }, method: 'PUT' }
    )
  }

  async listStorePublishingCredentials() {
    return this.request<{ credentials: BackendStorePublishingCredential[] }>(
      'v1/store-publishing/credentials'
    )
  }

  async createStorePublishingCredential(input: {
    provider: BackendStorePublishingCredential['provider']
    label: string
    metadata: Record<string, string>
    encryptedSecret: string
  }) {
    return this.request<BackendStorePublishingCredential>('v1/store-publishing/credentials', {
      body: input,
      method: 'POST',
    })
  }

  async getStorePublishingCredentialSecret(id: string) {
    return this.request<BackendStorePublishingCredential & { encryptedSecret: string }>(
      `v1/store-publishing/credentials/${encodeURIComponent(id)}/secret`,
      { method: 'POST' }
    )
  }

  async deleteStorePublishingCredential(id: string) {
    return this.request<{ deleted: boolean }>(
      `v1/store-publishing/credentials/${encodeURIComponent(id)}`,
      { method: 'DELETE' }
    )
  }
}
