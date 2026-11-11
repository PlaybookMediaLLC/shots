import 'server-only'

import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { isCampaignStudioConfigured } from '@/lib/ai/agents/campaign-studio'
import { reviewRevisedRender } from '@/lib/ai/launch/critique'
import { draftCampaignPlan, planCaptureUrls } from '@/lib/ai/launch/plan'
import { produceCampaign } from '@/lib/ai/launch/produce'
import { proposeCampaignRevision } from '@/lib/ai/launch/revise'
import { draftReleaseSpec } from '@/lib/ai/launch/spec'
import { withAiCredits } from '@/lib/ai/metering'
import { LAUNCH_AI_RATE_LIMIT } from '@/lib/api/rate-limit-policy'
import type { OrganizationAccess } from '@/lib/auth/access'
import { backendSDK } from '@/lib/backend/sdk'
import { renderDesignForTenant } from '@/lib/design/render-design'
import {
  createDesignRenderer,
  type DesignRenderer,
  isDesignRendererReady,
} from '@/lib/design/renderer'
import { findCitationIssues } from '@/lib/launch/citations'
import {
  campaignPlanSchema,
  releaseSpecSchema,
  SPEC_SECTIONS,
  validatePlanReferences,
} from '@/lib/launch/spec-schema'
import { cancelLaunchRun, getLaunchRun, latestLaunchRuns, startLaunchRun } from '@/lib/launch/runs'
import {
  applyRevision,
  approvePlan,
  approveSpec,
  discardRevision,
  getCampaignPlans,
  getRevision,
  getReleaseSpecs,
  getSpecById,
  getWorkingSpec,
  LaunchError,
  listRevisions,
  loadLaunchCampaign,
  savePlanVersion,
  saveSpecVersion,
} from '@/lib/launch/store'
import { checkRateLimit } from '@/lib/rate-limit'
import { consumeWorkspaceQuota } from '@/lib/tenant/entitlements'
import { getDesign } from '@/lib/tenant/designs'
import { router } from '../init'
import { organizationProcedure } from '../procedures'

/**
 * The launch pipeline API: cited release specs, campaign plans, production,
 * and AI revisions (docs/launch-intelligence.md). AI actions check that AI is
 * configured, rate-limit per workspace, and are charged AI credits for what
 * their model calls cost.
 */

const campaignInput = z.object({ campaignId: z.string().cuid() })

/**
 * Refuses an AI action when AI is not configured, the workspace turned AI
 * off, the workspace is rate limited, or out of credits.
 */
/**
 * The AI rule from values a caller already holds, such as a page's access:
 * configured, a paid plan, and not turned off by the workspace.
 */
export function aiAllowed(
  paidPlan: boolean,
  settings: { aiAgentEnabled: boolean } | null | undefined
): boolean {
  // No settings row is the default: on.
  return isCampaignStudioConfigured() && paidPlan && settings?.aiAgentEnabled !== false
}

/** True when AI is configured and the workspace has not turned it off. */
export async function isAiEnabled(access: OrganizationAccess): Promise<boolean> {
  if (!isCampaignStudioConfigured()) return false
  const sdk = backendSDK(access)
  if (!(await sdk.getFeatureDecision('workspace:paid')).allowed) return false
  const { workspace } = await sdk.getWorkspace()
  return aiAllowed(true, workspace?.workspaceSettings)
}

/** Refuse when AI is not configured or the workspace turned it off (the kill switch). */
export async function requireAiEnabled(access: OrganizationAccess): Promise<void> {
  if (!isCampaignStudioConfigured()) {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'AI is not configured. Set OPENROUTER_API_KEY.',
    })
  }
  if (!(await isAiEnabled(access))) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'AI is turned off for this workspace.' })
  }
}

export async function allowAiAction(access: OrganizationAccess): Promise<void> {
  await requireAiEnabled(access)
  const limit = await checkRateLimit(`launch-ai:${access.organizationId}`, LAUNCH_AI_RATE_LIMIT)
  if (!limit.allowed) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many AI requests. Wait a minute and try again.',
    })
  }
  // Refuse to start when no credits are left; the run is charged as it goes.
  await consumeWorkspaceQuota(access, 'ai:credits:monthly', 0)
}

async function releaseIdFor(access: OrganizationAccess, campaignId: string): Promise<string> {
  const campaign = await loadLaunchCampaign(access, campaignId)
  if (!campaign.release) throw new LaunchError('Link a release brief first.', 409)
  return campaign.release.id
}

const revisionTarget = z.discriminatedUnion('type', [
  z.object({
    section: z.enum(SPEC_SECTIONS),
    specId: z.string().cuid(),
    type: z.literal('spec_section'),
  }),
  z.object({ postId: z.string().cuid(), type: z.literal('post') }),
  z.object({ designId: z.string().cuid(), type: z.literal('design') }),
  z.object({ planId: z.string().cuid(), type: z.literal('plan') }),
])

export const launchRouter = router({
  /** Everything the campaign pages need to show where the pipeline stands. */
  overview: organizationProcedure('artifact:read')
    .input(campaignInput)
    .query(async ({ ctx, input }) => {
      const campaign = await loadLaunchCampaign(ctx.access, input.campaignId)
      const [specs, plans, revisions, runs] = await Promise.all([
        campaign.release ? getReleaseSpecs(ctx.access, campaign.release.id) : null,
        getCampaignPlans(ctx.access, campaign.id),
        listRevisions(ctx.access, campaign.id),
        latestLaunchRuns(ctx.access, campaign.id),
      ])
      return {
        aiConfigured: isCampaignStudioConfigured(),
        plans,
        revisions,
        runs,
        specs,
      }
    }),

  /** Poll a background run started by spec, plan, produce, or revision. */
  run: organizationProcedure('artifact:read')
    .input(z.object({ runId: z.string().cuid() }))
    .query(async ({ ctx, input }) => ({
      run: await getLaunchRun(ctx.access, input.runId),
    })),

  /** Cancel a running spec, plan, produce, or revision run. */
  cancelRun: organizationProcedure('release:create')
    .input(z.object({ runId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => cancelLaunchRun(ctx.access, input.runId)),

  spec: router({
    generate: organizationProcedure('release:create')
      .input(campaignInput)
      .mutation(async ({ ctx, input }) => {
        await allowAiAction(ctx.access)
        const run = await startLaunchRun(ctx.access, {
          campaignId: input.campaignId,
          kind: 'spec',
          work: async (signal) => {
            const spec = await draftReleaseSpec(ctx.access, input.campaignId, { signal })
            return { resultId: spec.id, summary: spec.changeSummary }
          },
        })
        return { run }
      }),
    /** Save a person's edit as a new version, keeping the base version's sources. */
    update: organizationProcedure('release:create')
      .input(
        z.object({
          baseSpecId: z.string().cuid(),
          campaignId: z.string().cuid(),
          content: releaseSpecSchema,
          summary: z.string().trim().min(1).max(300),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const releaseId = await releaseIdFor(ctx.access, input.campaignId)
        const base = await getSpecById(ctx.access, input.baseSpecId)
        const { latest } = await getReleaseSpecs(ctx.access, releaseId)
        if (base.releaseId !== releaseId) throw new LaunchError('Spec not found.', 404)
        if (latest && latest.id !== base.id) {
          throw new LaunchError(
            'Someone saved a newer version. Reload to edit the latest spec.',
            409
          )
        }
        const known = new Set(
          base.sources.filter((source) => source.status === 'ok').map((source) => source.id)
        )
        const issues = findCitationIssues(input.content, known)
        if (issues.length > 0) throw new LaunchError(issues.slice(0, 3).join(' '), 400)
        return {
          spec: await saveSpecVersion(ctx.access, {
            changeSummary: input.summary,
            content: input.content,
            origin: 'human',
            releaseId,
            sources: base.sources,
          }),
        }
      }),
    approve: organizationProcedure('release:approve')
      .input(z.object({ specId: z.string().cuid() }))
      .mutation(async ({ ctx, input }) => ({ spec: await approveSpec(ctx.access, input.specId) })),
  }),

  plan: router({
    /** `timelineItems` fixes the post count on the schedulable channels (onboarding). */
    generate: organizationProcedure('release:create')
      .input(campaignInput.extend({ timelineItems: z.number().int().min(1).max(24).optional() }))
      .mutation(async ({ ctx, input }) => {
        await allowAiAction(ctx.access)
        const run = await startLaunchRun(ctx.access, {
          campaignId: input.campaignId,
          kind: 'plan',
          work: async (signal) => {
            const plan = await draftCampaignPlan(ctx.access, input.campaignId, signal, {
              timelineItems: input.timelineItems,
            })
            return { resultId: plan.id, summary: plan.changeSummary }
          },
        })
        return { run }
      }),
    update: organizationProcedure('release:create')
      .input(
        z.object({
          basePlanId: z.string().cuid(),
          campaignId: z.string().cuid(),
          content: campaignPlanSchema,
          summary: z.string().trim().min(1).max(300),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const campaign = await loadLaunchCampaign(ctx.access, input.campaignId)
        const { latest } = await getCampaignPlans(ctx.access, campaign.id)
        if (!latest || latest.id !== input.basePlanId) {
          throw new LaunchError(
            'Someone saved a newer plan. Reload to edit the latest version.',
            409
          )
        }
        const spec = latest.specId
          ? await getSpecById(ctx.access, latest.specId)
          : campaign.release
            ? await getWorkingSpec(ctx.access, campaign.release.id)
            : null
        if (!spec) throw new LaunchError('Draft the spec first.', 409)
        const captureUrls = await planCaptureUrls(ctx.access, campaign, spec.content)
        const issues = validatePlanReferences(input.content, spec.content, captureUrls)
        if (issues.length > 0) throw new LaunchError(issues.slice(0, 3).join(' '), 400)
        return {
          plan: await savePlanVersion(ctx.access, {
            campaignId: campaign.id,
            changeSummary: input.summary,
            content: input.content,
            origin: 'human',
            specId: latest.specId,
          }),
        }
      }),
    approve: organizationProcedure('release:approve')
      .input(z.object({ planId: z.string().cuid() }))
      .mutation(async ({ ctx, input }) => ({ plan: await approvePlan(ctx.access, input.planId) })),
  }),

  /** Visuals and copy from the plan. Long-running: the route allows up to five minutes. */
  produce: organizationProcedure('release:create')
    .input(campaignInput)
    .mutation(async ({ ctx, input }) => {
      await allowAiAction(ctx.access)
      const run = await startLaunchRun(ctx.access, {
        campaignId: input.campaignId,
        kind: 'produce',
        work: async (signal, runId) => {
          const result = await produceCampaign(ctx.access, input.campaignId, { runId, signal })
          return {
            summary:
              `${result.assetCount} visual${result.assetCount === 1 ? '' : 's'} and ${result.postCount} post${result.postCount === 1 ? '' : 's'}${result.designMode ? '' : ' (product shots: the editor renderer was unavailable)'}. ${result.summary}`.trim(),
          }
        },
      })
      return { run }
    }),

  revision: router({
    propose: organizationProcedure('release:create')
      .input(
        z.object({
          campaignId: z.string().cuid(),
          comment: z.string().trim().min(3).max(1_000),
          target: revisionTarget,
        })
      )
      .mutation(async ({ ctx, input }) => {
        await allowAiAction(ctx.access)
        const run = await startLaunchRun(ctx.access, {
          campaignId: input.campaignId,
          kind: 'revision',
          work: async (signal) => {
            const revision = await proposeCampaignRevision(ctx.access, { ...input, signal })
            return { resultId: revision.id, summary: revision.proposal.summary }
          },
        })
        return { run }
      }),
    get: organizationProcedure('artifact:read')
      .input(z.object({ revisionId: z.string().cuid() }))
      .query(async ({ ctx, input }) => {
        return { revision: await getRevision(ctx.access, input.revisionId) }
      }),
    /** Apply the primary change and the chosen related updates; re-render changed designs. */
    accept: organizationProcedure('release:create')
      .input(
        z.object({
          related: z.array(z.number().int().min(0).max(20)).max(20).default([]),
          revisionId: z.string().cuid(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const result = await applyRevision(ctx.access, input.revisionId, input.related)
        let rendered = 0
        if (result.designIds.length > 0 && (await isDesignRendererReady())) {
          const lazy: { renderer: Promise<DesignRenderer> | null } = { renderer: null }
          const getRenderer = () => (lazy.renderer ??= createDesignRenderer())
          try {
            for (const designId of result.designIds) {
              const design = await getDesign(ctx.access, designId)
              if (!design) continue
              const render = await renderDesignForTenant(ctx.access, getRenderer, design)
              rendered += 1
              // Every render is reviewed, including the ones a reviewer asked for.
              const imageBytes = await render.readBytes()
              const critique = await withAiCredits(ctx.access, () =>
                reviewRevisedRender({
                  campaignId: result.revision.campaignId,
                  imageBytes,
                  tenant: ctx.access,
                  texts: design.document.texts.map((text) => text.text),
                })
              ).catch(() => null)
              if (critique) {
                await backendSDK(ctx.access).setLaunchDesignCritique(design.id, critique)
              }
            }
          } catch (error) {
            console.error('Re-render after revision failed.', {
              reason: error instanceof Error ? error.message : 'unknown',
            })
          } finally {
            if (lazy.renderer) await (await lazy.renderer).close().catch(() => undefined)
          }
        }
        return { rendered, revision: result.revision }
      }),
    discard: organizationProcedure('release:create')
      .input(z.object({ revisionId: z.string().cuid() }))
      .mutation(async ({ ctx, input }) => ({
        revision: await discardRevision(ctx.access, input.revisionId),
      })),
  }),
})
