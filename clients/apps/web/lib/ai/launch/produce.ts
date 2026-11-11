import 'server-only'

import { generateText, stepCountIs } from 'ai'
import type { OrganizationAccess } from '@/lib/auth/access'
import { backendSDK } from '@/lib/backend/sdk'
import {
  createDesignRenderer,
  type DesignRenderer,
  isDesignRendererReady,
} from '@/lib/design/renderer'
import { brandGradient } from '@/lib/launch/brand'
import { productionBudget, unproducedAssets } from '@/lib/launch/budget'
import { listSpecClaims } from '@/lib/launch/spec-schema'
import {
  getActiveBrand,
  getWorkingPlan,
  getWorkingSpec,
  LaunchError,
  loadLaunchCampaign,
  loadPreferenceExamples,
} from '@/lib/launch/store'
import { listCampaignDesigns } from '@/lib/tenant/designs'
import { models, normalizeTokenUsage } from '../models'
import { type CampaignStudioRecord, createCampaignStudioTools } from '../tools/campaign-studio'
import { createDesignStudioTools } from '../tools/design-studio'
import { createToolRun, flushToolRun, isRunStopped } from '../tools/executor'
import { formatBrandKit, formatPlanForStages, formatSpecForStages } from './context'
import { writeLaunchCopy } from './copy'
import { critiqueRender } from './critique'
import { planCaptureUrls } from './plan'
import { VISUALS_FALLBACK_INSTRUCTIONS, VISUALS_INSTRUCTIONS } from './prompts'
import { voiceInstructions } from '@/lib/write/voice'

/**
 * Produce the campaign from its plan: on-brand visuals (rendered in the
 * editor and self-reviewed, or product shots when the renderer is down) and
 * channel copy, side by side. Works from the approved spec and plan when they
 * exist, else the latest drafts. Whatever finished is kept if the other half
 * fails. Tools act with the caller's role; `runId` is the launch run their
 * calls are audited against and traced on, one step per call.
 */
export async function produceCampaign(
  tenant: OrganizationAccess,
  campaignId: string,
  { runId, signal }: { runId?: string; signal?: AbortSignal } = {}
) {
  const campaign = await loadLaunchCampaign(tenant, campaignId)
  if (!campaign.release) throw new LaunchError('Link a release brief first.', 409)
  const [spec, plan] = await Promise.all([
    getWorkingSpec(tenant, campaign.release.id),
    getWorkingPlan(tenant, campaignId),
  ])
  if (!spec) throw new LaunchError('Draft the spec first.', 409)
  if (!plan) throw new LaunchError('Plan the campaign first.', 409)
  const captureUrls = await planCaptureUrls(tenant, campaign, spec.content)
  if (captureUrls.length === 0) {
    throw new LaunchError('Connect a public product URL before producing visuals.', 409)
  }
  const [brand, examples] = await Promise.all([
    getActiveBrand(tenant),
    loadPreferenceExamples(tenant),
  ])
  signal?.throwIfAborted()

  const record: CampaignStudioRecord = { assets: [], savedPosts: 0 }
  const run = createToolRun({
    access: tenant,
    audit: (event) => backendSDK(tenant).appendAuditEvent(event),
    launchRunId: runId,
    recordStep: runId ? (step) => backendSDK(tenant).appendLaunchRunStep(runId, step) : undefined,
    signal,
  })
  const scope = {
    allowedUrls: captureUrls as [string, ...string[]],
    campaignId,
    planVersion: plan.version,
    run,
    tenant,
  }
  const designMode = await isDesignRendererReady()
  // A re-run makes only what an earlier run of this plan version did not finish.
  const remaining = designMode
    ? unproducedAssets(plan.content.assets, await listCampaignDesigns(tenant, campaignId), {
        brandUpdatedAt: brand.kitUpdatedAt,
        planVersion: plan.version,
      })
    : plan.content.assets
  const finished = plan.content.assets.filter((asset) => !remaining.includes(asset))
  const budget = productionBudget({ assets: remaining })
  const baseTools = createCampaignStudioTools(scope, record, budget)
  let renderer: Promise<DesignRenderer> | null = null
  const getRenderer = () => (renderer ??= createDesignRenderer())
  const claims = listSpecClaims(spec.content).map((claim) => claim.text)
  const tools = designMode
    ? {
        captureProductPage: baseTools.captureProductPage,
        createProductShot: baseTools.createProductShot,
        ...createDesignStudioTools(scope, record, getRenderer, {
          brand: brand.kit,
          critique: ({ previewJpegBase64, signal: abortSignal, texts }) =>
            critiqueRender({ abortSignal, brand: brand.kit, claims, previewJpegBase64, texts }),
          limits: budget,
        }),
      }
    : {
        captureProductPage: baseTools.captureProductPage,
        createProductShot: baseTools.createProductShot,
      }

  const prompt = [
    formatSpecForStages(spec.content, spec.version),
    formatPlanForStages(plan.content, plan.version),
    formatBrandKit(brand.kit) ??
      'No brand kit is set. Choose one background family and text color and keep them across the set.',
    // Headlines and captions on the visuals are public copy in the brand voice.
    voiceInstructions(brand.voice),
    !designMode && brand.kit
      ? `Product shot colors: background gradient from ${brand.kit.background} to ${brand.kit.accent} (${brandGradient(brand.kit)}), text ${brand.kit.foreground}.`
      : null,
    `<capture_urls>\n${captureUrls.join('\n')}\n</capture_urls>`,
    finished.length === 0
      ? 'Produce every asset in the plan.'
      : `Plan assets ${finished.map((asset) => asset.key).join(', ')} are already produced and rendered; leave them. Produce only ${remaining.map((asset) => asset.key).join(', ')}.`,
  ]
    .filter(Boolean)
    .join('\n\n')

  // The copy works from the spec and plan, not the visuals, so both run at once.
  // The visuals agent drafts on Sonnet: its long tool loop is most of a launch's cost.
  const [visualsRun, copyRun] = await Promise.allSettled([
    remaining.length === 0
      ? null
      : generateText({
          abortSignal: signal,
          model: models.languageModel('drafting'),
          prompt,
          stopWhen: [
            stepCountIs(designMode ? budget.steps : Math.ceil(budget.steps / 2)),
            isRunStopped(run),
          ],
          system: designMode ? VISUALS_INSTRUCTIONS : VISUALS_FALLBACK_INSTRUCTIONS,
          tools,
        }).finally(async () => {
          if (renderer) await (await renderer).close().catch(() => undefined)
          await flushToolRun(run)
        }),
    writeLaunchCopy(tenant, { brand, campaign, examples, plan, signal, spec }),
  ])
  if (visualsRun.status === 'rejected') throw visualsRun.reason
  if (copyRun.status === 'rejected') throw copyRun.reason
  const visuals = visualsRun.value
  const copy = copyRun.value
  const usage = normalizeTokenUsage(visuals?.totalUsage)
  const reusedCount = finished.reduce((total, asset) => total + asset.variants, 0)
  signal?.throwIfAborted()
  await backendSDK(tenant).appendAuditEvent({
    action: 'product.campaign_produced',
    entityId: campaignId,
    entityType: 'campaign',
    metadata: {
      assetCount: record.assets.length,
      designMode,
      inputUsage: usage.inputTokens,
      modelId: models.modelId('drafting'),
      outputUsage: usage.outputTokens,
      planVersion: plan.version,
      postCount: copy.postCount,
      reusedCount,
      specVersion: spec.version,
      steps: visuals?.steps.length ?? 0,
    },
  })
  return {
    assetCount: record.assets.length + reusedCount,
    designMode,
    postCount: copy.postCount,
    summary: visuals?.text ?? `Every visual in plan version ${plan.version} was already produced.`,
  }
}
