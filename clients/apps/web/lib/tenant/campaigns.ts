import 'server-only'

import {
  type BackendCampaignPost,
  type BackendCampaignStatus,
  BackendSDKError,
  prohibitedTermMatches,
} from 'screenshot-studio-backend-sdk'
import { backendSDK, orNull, withDates } from '@/lib/backend/sdk'
import { linkPreviewAgentSchema } from '@/lib/api/contracts/link-preview'
import type { TenantContext } from '@/lib/auth/access'
import { readLinkPreview } from '@/lib/link-preview/fetch'
import { postLinkProblems } from '@/lib/link-preview/gate'
import { type PostEditResult, type PostSnapshot, postFields } from '@/lib/launch/post-edit'
import type { CampaignApprovalDecision } from './campaign-status'
import type { CampaignPublishDraftInput } from './campaign-publish-draft'
import type {
  CampaignCreateInput,
  CampaignPostScheduleInput,
  CampaignPostUpdateInput,
} from './schemas'

export class CampaignError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409
  ) {
    super(message)
    this.name = 'CampaignError'
  }
}

export async function listCampaigns(context: TenantContext) {
  return withDates((await backendSDK(context).listCampaigns()).campaigns)
}

export async function getCampaign(context: TenantContext, campaignId: string) {
  return withDates(await orNull(backendSDK(context).getCampaign(campaignId)))
}

/**
 * New campaigns start as DRAFT; the backend links the release and its
 * surface. A retried create with the same `idempotencyKey` returns the first
 * campaign with `created: false`.
 */
export async function createCampaign(
  context: TenantContext,
  input: CampaignCreateInput,
  idempotencyKey?: string
) {
  for (const post of input.posts) {
    if (post.angleIndex !== undefined && post.angleIndex >= input.angles.length) {
      throw new CampaignError('A post references an angle that does not exist.', 400)
    }
  }
  return withDates(await backendSDK(context).createCampaign({ ...input, idempotencyKey }))
}

/** The review queue: posts waiting for a reviewer's decision, oldest first. */
export async function listPendingApprovals(
  context: TenantContext,
  options: { cursor?: string; limit: number }
) {
  return withDates(await backendSDK(context).listPendingApprovals(options))
}

/**
 * Move draft or needs-changes posts to review, every eligible post when
 * `postIds` is omitted. An API key with `release:create` may do this; only a
 * person approves (RFC 012).
 */
export async function requestCampaignReview(
  context: TenantContext,
  campaignId: string,
  postIds?: readonly string[]
) {
  return backendSDK(context).submitCampaignPosts(campaignId, postIds)
}

/**
 * Move a campaign through its lifecycle. The backend checks the transition
 * table against the stored status and the caller's role, and applies the
 * write conditionally so two racing transitions cannot both apply.
 */
export async function transitionCampaign(
  access: TenantContext,
  campaignId: string,
  to: BackendCampaignStatus
) {
  return backendSDK(access).transitionCampaign(campaignId, to)
}

export async function transitionCampaignPosts(
  context: TenantContext,
  campaignId: string,
  decision: CampaignApprovalDecision,
  postIds?: readonly string[],
  note?: string
) {
  return backendSDK(context).decideCampaignPosts(campaignId, { decision, note, postIds })
}

/**
 * The backend creates the canonical scheduled post and starts its workflow.
 * First every link in the post is read the way platforms will read it; a
 * link whose preview is broken stops the schedule unless the caller skips
 * the check on purpose.
 */
export async function scheduleCampaignPost(
  context: TenantContext,
  campaignId: string,
  postId: string,
  input: CampaignPostScheduleInput
) {
  if (!input.skipLinkCheck) {
    const post = (await getCampaign(context, campaignId))?.posts.find(
      (entry) => entry.id === postId
    )
    const problems = post
      ? await postLinkProblems(post.copy, (url) =>
          readLinkPreview(url, linkPreviewAgentSchema.enum.default)
        )
      : []
    if (problems.length) {
      throw new CampaignError(
        `Not scheduled: a link in this post would preview badly. ${problems.join(' ')} Fix the page, or schedule again with the link check skipped.`,
        409
      )
    }
  }
  return withDates(
    await backendSDK(context).scheduleCampaignPost(campaignId, postId, {
      channelConnectionId: input.channelConnectionId,
      creativeVariantId: input.creativeVariantId,
      scheduledAt: input.scheduledAt?.toISOString(),
    })
  )
}

/**
 * An edited campaign visual becomes a Publish draft. The backend attaches
 * the export to the campaign and creates the draft in one transaction, so a
 * failure leaves neither, and the draft keeps the campaign it came from.
 */
export async function createCampaignPublishDraft(
  context: TenantContext,
  input: CampaignPublishDraftInput
) {
  const { campaignId, ...handoff } = input
  return withDates(await backendSDK(context).createCampaignPublishDraft(campaignId, handoff))
}

/** Approve a design's current render as the visual its posts publish with. */
export async function approveCampaignDesign(
  context: TenantContext,
  campaignId: string,
  designId: string
) {
  return backendSDK(context).approveCampaignDesign(campaignId, designId)
}

function postSnapshot(
  post: Pick<BackendCampaignPost, 'callToAction' | 'copy' | 'status' | 'title'>
): PostSnapshot {
  return { ...postFields(post), status: post.status }
}

/**
 * A person's edit to a post's copy, call to action, or title. The backend
 * applies the revision rules: an approved post returns to draft, a live post
 * cannot change. Copy with a prohibited term comes back as its matches, and
 * an edit made against copy that changed since comes back with the current
 * post, so the author decides which version to keep.
 */
export async function updateCampaignPost(
  context: TenantContext,
  campaignId: string,
  postId: string,
  input: CampaignPostUpdateInput
): Promise<PostEditResult> {
  try {
    const post = await backendSDK(context).updateCampaignPost(campaignId, postId, input)
    return { outcome: 'saved', post: postSnapshot(post) }
  } catch (error) {
    const matches = prohibitedTermMatches(error)
    if (matches) return { matches, outcome: 'prohibited' }
    if (!(error instanceof BackendSDKError) || error.status !== 409) throw error
    // Other conflicts (a live or published post) keep their message; only
    // copy that moved on is a stale edit.
    const current = (await getCampaign(context, campaignId))?.posts.find(
      (entry) => entry.id === postId
    )
    if (!current || current.copy === input.expectedCopy) throw error
    return { outcome: 'stale', post: postSnapshot(current) }
  }
}
