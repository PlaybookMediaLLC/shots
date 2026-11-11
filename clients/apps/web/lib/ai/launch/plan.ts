import 'server-only'

import type { TenantContext } from '@/lib/auth/access'
import { backendSDK } from '@/lib/backend/sdk'
import { formatTeamPreferences } from '@/lib/launch/preferences-format'
import {
  campaignPlanSchema,
  type ReleaseSpecContent,
  validatePlanReferences,
} from '@/lib/launch/spec-schema'
import {
  getActiveBrand,
  getWorkingSpec,
  type LaunchCampaign,
  LaunchError,
  loadLaunchCampaign,
  loadPreferenceExamples,
  releaseSourceUrls,
  savePlanVersion,
  type StoredPlan,
} from '@/lib/launch/store'
import { defuseMarkup } from '@/lib/launch/sanitize'
import { type PlanTarget, planTargetIssues, targetChannels } from '@/lib/onboarding/plan-target'
import { getProductProfile } from '@/lib/tenant/product-profile'
import {
  captureUrlsFor,
  formatBrandKit,
  formatCaptureTargets,
  formatProductProfile,
  formatSpecForStages,
} from './context'
import { PLAN_INSTRUCTIONS, planTargetLine } from './prompts'
import { runSubmitStage, stageMetadata } from './run'
import { voiceInstructions } from '@/lib/write/voice'

/** Capabilities looked up against the workspace's product surfaces. */
const MATCHED_FEATURES = 3

/**
 * The URLs a campaign's visuals may capture: the product, the surfaces that
 * match the spec's capabilities, then the release's sources. A surface that
 * only matched as the fallback (the homepage) comes last, and is dropped when
 * it is already listed.
 */
export async function planCaptureUrls(
  tenant: TenantContext,
  campaign: LaunchCampaign,
  spec: ReleaseSpecContent
): Promise<string[]> {
  const backend = backendSDK(tenant)
  const found = await Promise.all(
    spec.capabilities.slice(0, MATCHED_FEATURES).map((capability) =>
      backend
        .findSurfacesForFeature({ feature: capability.name, limit: 2 })
        .then((result) => result.matches)
        // Matching only adds capture targets; the plan works without it.
        .catch(() => [])
    )
  )
  const matches = found.flat()
  const urls = (fallback: boolean) =>
    matches.filter((match) => (match.reason === 'fallback') === fallback).map((m) => m.surface.url)
  return captureUrlsFor([
    campaign.productSurface?.url,
    ...urls(false),
    ...releaseSourceUrls(campaign),
    ...urls(true),
  ])
}

/** The channels and post count a targeted plan must have. */
async function resolveTarget(tenant: TenantContext, timelineItems: number): Promise<PlanTarget> {
  const connections = await backendSDK(tenant)
    .listConnections()
    .then((result) => result.items)
    .catch(() => [])
  return { channels: targetChannels(connections), timelineItems }
}

/**
 * Plan the campaign from the release's approved (or latest) spec. With
 * `timelineItems`, the plan has exactly that many posts on the schedulable
 * channels (onboarding's first campaign); without it, the planner chooses.
 */
export async function draftCampaignPlan(
  tenant: TenantContext,
  campaignId: string,
  signal?: AbortSignal,
  options: { timelineItems?: number } = {}
): Promise<StoredPlan> {
  const campaign = await loadLaunchCampaign(tenant, campaignId)
  if (!campaign.release) throw new LaunchError('Link a release brief before planning.', 409)
  const spec = await getWorkingSpec(tenant, campaign.release.id)
  if (!spec) throw new LaunchError('Draft the spec before planning the campaign.', 409)

  const [brand, examples, product, captureUrls, target] = await Promise.all([
    getActiveBrand(tenant),
    loadPreferenceExamples(tenant),
    getProductProfile(tenant).catch(() => null),
    planCaptureUrls(tenant, campaign, spec.content),
    options.timelineItems ? resolveTarget(tenant, options.timelineItems) : null,
  ])
  const prompt = [
    formatSpecForStages(spec.content, spec.version),
    [
      '<campaign>',
      `Name: ${defuseMarkup(campaign.name)}`,
      `Objective: ${defuseMarkup(campaign.objective)}`,
      campaign.productSurface
        ? `Product: ${defuseMarkup(campaign.productSurface.name)} (${campaign.productSurface.url})`
        : null,
      '</campaign>',
    ]
      .filter(Boolean)
      .join('\n'),
    formatProductProfile(product),
    formatCaptureTargets(captureUrls, spec.sources),
    voiceInstructions(brand.voice),
    formatBrandKit(brand.kit),
    formatTeamPreferences(examples),
    target ? planTargetLine(target) : null,
    'Plan the launch campaign.',
  ]
    .filter(Boolean)
    .join('\n\n')

  const run = await runSubmitStage({
    abortSignal: signal,
    description:
      'Submit the complete campaign plan. Angles cite spec claim refs; assets and timeline ' +
      'items reference angle and asset keys; capture hints use registered URLs only.',
    maxSteps: 6,
    prompt,
    role: 'deep',
    schema: campaignPlanSchema,
    system: PLAN_INSTRUCTIONS,
    toolName: 'submitPlan',
    validate: (plan) => [
      ...validatePlanReferences(plan, spec.content, captureUrls),
      ...(target ? planTargetIssues(plan, target) : []),
    ],
  })
  if (!run.value) throw new LaunchError('The plan could not be drafted. Try again.', 503)
  return savePlanVersion(tenant, {
    campaignId,
    changeSummary: `Planned from spec v${spec.version}${spec.status === 'APPROVED' ? '' : ' (draft)'}`,
    content: run.value,
    metadata: {
      ...stageMetadata(run),
      specVersion: spec.version,
      ...(target ? { timelineTarget: target.timelineItems } : {}),
    },
    modelId: run.modelId,
    origin: 'ai',
    specId: spec.id,
  })
}
