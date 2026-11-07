import 'server-only'

import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { campaignPostTransitions } from '@/lib/tenant/campaign-status'
import {
  approveCampaignDesign,
  createCampaign,
  createCampaignPublishDraft,
  getCampaign,
  listCampaigns,
  scheduleCampaignPost,
  transitionCampaign,
  transitionCampaignPosts,
  updateCampaignPost,
} from '@/lib/tenant/campaigns'
import { campaignPublishDraftSchema } from '@/lib/tenant/campaign-publish-draft'
import {
  campaignApprovalSchema,
  campaignCreateSchema,
  campaignPostScheduleSchema,
  campaignPostUpdateSchema,
  campaignTransitionSchema,
} from '@/lib/tenant/schemas'
import { runCampaignStudio } from '@/lib/ai/agents/campaign-studio'
import { withAiCredits } from '@/lib/ai/metering'
import { requireActiveOrganizationPermission } from '@/lib/auth/access'
import { backendSDK } from '@/lib/backend/sdk'
import { router, publicProcedure } from '../init'
import { allowAiAction } from './launch'
import { organizationProcedure } from '../procedures'

const campaignIdSchema = z.object({ campaignId: z.string().cuid() })

export const campaignRouter = router({
  list: organizationProcedure('artifact:read').query(async ({ ctx }) => {
    const campaigns = await listCampaigns(ctx.access)
    return { campaigns }
  }),
  get: organizationProcedure('artifact:read')
    .input(campaignIdSchema)
    .query(async ({ ctx, input }) => {
      const campaign = await getCampaign(ctx.access, input.campaignId)
      if (!campaign) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found.' })
      }
      return { campaign }
    }),
  create: organizationProcedure('release:create')
    .input(
      campaignCreateSchema.extend({ idempotencyKey: z.string().trim().min(1).max(128).optional() })
    )
    .mutation(async ({ ctx, input }) => {
      const campaign = await createCampaign(ctx.access, input, input.idempotencyKey)
      return { campaign }
    }),
  /**
   * Run the campaign studio agent: capture the product, composite product
   * shots, and draft posts. Charged to the workspace's AI credits.
   */
  generate: organizationProcedure('release:create')
    .input(z.object({ campaignId: z.string().cuid() }))
    .mutation(async ({ ctx, input, signal }) => {
      await allowAiAction(ctx.access)
      return withAiCredits(ctx.access, () =>
        runCampaignStudio(ctx.access, input.campaignId, signal)
      )
    }),
  /** The transition table decides the permission; artifact:read only gates membership. */
  transition: organizationProcedure('artifact:read')
    .input(campaignTransitionSchema)
    .mutation(async ({ ctx, input }) => ({
      campaign: await transitionCampaign(ctx.access, input.campaignId, input.status),
    })),
  decideApproval: publicProcedure
    .input(campaignApprovalSchema.safeExtend({ campaignId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const access = await requireActiveOrganizationPermission(
        ctx.headers,
        campaignPostTransitions[input.decision].permission
      )
      return transitionCampaignPosts(
        access,
        input.campaignId,
        input.decision,
        input.postIds,
        input.note
      )
    }),
  /** Approve a design's current render so its posts can be scheduled with it. */
  approveDesign: organizationProcedure('release:approve')
    .input(campaignIdSchema.extend({ designId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await approveCampaignDesign(ctx.access, input.campaignId, input.designId)
      return { approved: true }
    }),
  /** Approve the current fallback product shot, preserving its exact render. */
  approveAsset: organizationProcedure('release:approve')
    .input(campaignIdSchema.extend({ assetId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await backendSDK(ctx.access).approveCampaignAsset(input.campaignId, input.assetId)
      return { approved: true }
    }),
  /**
   * An edited campaign visual becomes a Publish draft. The backend checks the
   * campaign role again and does the asset link and the draft in one
   * transaction; `release:create` here only gates membership and the role
   * that may change a campaign.
   */
  publishDraft: organizationProcedure('release:create')
    .input(campaignPublishDraftSchema)
    .mutation(async ({ ctx, input }) => ({
      draft: await createCampaignPublishDraft(ctx.access, input),
    })),
  /** A hand edit to a post; stale copy and prohibited terms come back as outcomes. */
  updatePost: organizationProcedure('release:create')
    .input(
      campaignPostUpdateSchema.extend({
        campaignId: z.string().cuid(),
        postId: z.string().cuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { campaignId, postId, ...edit } = input
      return updateCampaignPost(ctx.access, campaignId, postId, edit)
    }),
  schedulePost: organizationProcedure('publish:manage')
    .input(
      campaignPostScheduleSchema.extend({
        campaignId: z.string().cuid(),
        postId: z.string().cuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { campaignId, postId, ...schedule } = input
      const post = await scheduleCampaignPost(ctx.access, campaignId, postId, schedule)
      return { post }
    }),
})
