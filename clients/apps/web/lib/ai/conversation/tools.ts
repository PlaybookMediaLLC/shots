import 'server-only'

import { BackendSDKError } from 'screenshot-studio-backend-sdk'
import { z } from 'zod'
import { draftCampaignPlan } from '@/lib/ai/launch/plan'
import { produceCampaign } from '@/lib/ai/launch/produce'
import { draftReleaseSpec } from '@/lib/ai/launch/spec'
import { defineTool, type ToolRun } from '@/lib/ai/tools/executor'
import { marketingTools } from '@/lib/ai/tools/marketing'
import { marketingServices } from '@/lib/ai/tools/marketing-services'
import { backendSDK } from '@/lib/backend/sdk'
import { getWorkingPlan, getWorkingSpec, LaunchError, loadLaunchCampaign } from '@/lib/launch/store'
import { ensureProductSurface, plain } from '@/lib/onboarding/first-campaign'
import { CampaignError, createCampaign, getCampaign } from '@/lib/tenant/campaigns'
import { getProductProfile } from '@/lib/tenant/product-profile'
import { createRelease, ReleaseError } from '@/lib/tenant/releases'
import type { StepFix } from './steps'

/**
 * The conversational agent's tools (RFC 028): the RFC 027 marketing tools,
 * plus creating the campaign for a shipped feature, drafting it through the
 * launch pipeline (spec, plan, produce), and asking one clarifying question.
 * Every tool goes through `defineTool`, so a role without `release:create`
 * (a viewer) reads and creates nothing. There is no approve tool:
 * `requestApproval` only submits.
 */

/** What one turn's tools share. */
export type TurnState = {
  /** The conversation's campaign; set when `createCampaign` makes one. */
  campaignId: string | null
  /** The question `askClarification` asked; the turn ends on it. */
  clarification: { options: string[]; question: string } | null
  readonly conversationId: string
}

const failure = (error: string, fix?: StepFix) => ({
  error,
  ok: false as const,
  ...(fix ? { fix } : {}),
})

/**
 * Domain refusals are permanent: they return as the tool's own failure
 * (REJECTED), which offers a corrective action instead of a retry. Anything
 * else throws, which the executor records as FAILED, a transient failure.
 */
async function permanent<T>(work: () => Promise<T>) {
  try {
    return await work()
  } catch (error) {
    if (
      error instanceof LaunchError ||
      error instanceof CampaignError ||
      error instanceof ReleaseError ||
      (error instanceof BackendSDKError && error.status < 429)
    ) {
      return failure(error.message)
    }
    throw error
  }
}

/** The tool set for one turn, or for retrying one of its steps. */
export function conversationTools(run: ToolRun, state: TurnState, { canAsk }: { canAsk: boolean }) {
  const access = run.access
  const marketing = marketingTools(run, {
    campaignId: () => state.campaignId ?? undefined,
    services: marketingServices,
  })

  const askClarification = defineTool(run, {
    description:
      'Ask the user one question when several product pages match the feature, listing the ' +
      'pages as options. The turn ends after it.',
    effect: 'read',
    execute: ({ options, question }) => {
      state.clarification = { options, question }
      return { asked: true, ok: true as const }
    },
    inputSchema: z.object({
      options: z.array(z.string().trim().min(1).max(120)).min(2).max(6),
      question: z.string().trim().min(1).max(300),
    }),
    maxCallsPerRun: 1,
    name: 'askClarification',
    permission: 'workspace:read',
    timeoutMs: 5_000,
  })

  const createCampaignTool = defineTool(run, {
    description:
      'Create the release brief and draft campaign for the feature the user shipped, on the ' +
      'product page listProductSurfaces found (its slug), or the homepage without one. ' +
      'Returns the existing campaign when the conversation has one.',
    effect: 'draft',
    execute: ({ benefit, feature, surfaceSlug }) =>
      permanent(async () => {
        const backend = backendSDK(access)
        const linked =
          state.campaignId ??
          (await backend.getConversation(state.conversationId)).conversation.campaignId
        if (linked) {
          state.campaignId = linked
          return { campaignId: linked, created: false, ok: true as const }
        }
        const [profile, surfaces] = await Promise.all([
          getProductProfile(access),
          marketingServices.listProductSurfaces(access),
        ])
        if (surfaceSlug && !surfaces.some((entry) => entry.slug === surfaceSlug))
          return failure(
            'That product page no longer exists. List the product pages and choose one again.'
          )
        const surface =
          surfaces.find((entry) => entry.slug === surfaceSlug) ??
          (profile ? await ensureProductSurface(access, profile) : surfaces[0])
        if (!surface) return failure('Add your product before creating a campaign.', 'onboarding')
        const productProfile =
          profile && new URL(profile.url).origin === new URL(surface.url).origin ? profile : null
        const name = plain(`${feature} launch`, 160)
        const { release } = await createRelease(access, {
          audience: plain(productProfile?.audience ?? '', 1_000) || undefined,
          benefitStatement: plain(benefit, 500),
          description:
            plain(
              `${feature}\n\n${productProfile?.summary ?? surface.description ?? ''}`,
              10_000
            ) || undefined,
          // One release per conversation, so a retried call does not make a second.
          idempotencyKey: `conversation:${state.conversationId}`,
          productSurfaceId: surface.id,
          sourceUrls: [...new Set([surface.url, ...(productProfile ? [productProfile.url] : [])])],
          title: plain(feature, 160),
        })
        const campaign = await createCampaign(access, {
          angles: [],
          audience: plain(productProfile?.audience ?? '', 1_000) || undefined,
          feature: plain(feature, 500),
          name,
          objective: 'Launch',
          posts: [],
          productSurfaceId: surface.id,
          releaseId: release.id,
        })
        state.campaignId = campaign.id
        await backend
          .updateConversation(state.conversationId, { campaignId: campaign.id })
          // Only the author or an admin links; the campaign exists either way.
          .catch((error: unknown) => {
            console.error('Linking the conversation to its campaign failed.', {
              reason: error instanceof Error ? error.message : 'unknown',
            })
          })
        return {
          campaignId: campaign.id,
          created: true,
          name,
          ok: true as const,
          surface: surface.name,
        }
      }),
    inputSchema: z.object({
      benefit: z.string().trim().min(1).max(200).describe('Why it matters, in one sentence.'),
      feature: z.string().trim().min(1).max(120).describe('The feature, in a few words.'),
      surfaceSlug: z.string().trim().min(1).max(120).optional(),
    }),
    maxCallsPerRun: 1,
    name: 'createCampaign',
    permission: 'release:create',
    timeoutMs: 30_000,
  })

  const generateCampaign = defineTool(run, {
    description:
      "Draft this conversation's campaign: a cited spec, a plan, then visuals and posts. Takes " +
      'a few minutes. Keeps what is already drafted.',
    effect: 'draft',
    execute: (_input, { signal }) =>
      permanent(async () => {
        const campaignId = state.campaignId
        if (!campaignId) return failure('Create the campaign first.')
        const campaign = await loadLaunchCampaign(access, campaignId)
        if (!campaign.release) return failure('This campaign has no release brief.')
        // Each stage keeps what an earlier call drafted, so a retry resumes.
        if (!(await getWorkingSpec(access, campaign.release.id))) {
          await draftReleaseSpec(access, campaignId, { signal })
        }
        if (!(await getWorkingPlan(access, campaignId))) {
          await draftCampaignPlan(access, campaignId, signal)
        }
        const existing = await getCampaign(access, campaignId)
        const posts = existing?.posts.length ?? 0
        const assets = existing?.assets.length ?? 0
        if (posts > 0 && assets > 0)
          return { assetCount: assets, campaignId, ok: true as const, postCount: posts, produced: false }
        // ponytail: produce runs untraced; its own tool steps would reuse this run's indexes.
        const result = await produceCampaign(access, campaignId, { signal })
        return {
          assetCount: result.assetCount,
          campaignId,
          ok: true as const,
          postCount: result.postCount,
          produced: true,
        }
      }),
    inputSchema: z.object({}),
    maxCallsPerRun: 1,
    name: 'generateCampaign',
    permission: 'release:create',
    timeoutMs: 20 * 60_000,
  })

  return {
    ...marketing,
    ...(canAsk ? { askClarification } : {}),
    createCampaign: createCampaignTool,
    generateCampaign,
  }
}
