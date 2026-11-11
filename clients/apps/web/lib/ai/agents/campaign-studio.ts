import 'server-only'

import { generateText, stepCountIs } from 'ai'
import type { OrganizationAccess } from '@/lib/auth/access'
import { backendSDK } from '@/lib/backend/sdk'
import { assertPublicCaptureUrl } from '@/lib/screenshot-service'
import {
  createDesignRenderer,
  type DesignRenderer,
  isDesignRendererReady,
} from '@/lib/design/renderer'
import { CampaignError, getCampaign } from '@/lib/tenant/campaigns'
import { models, normalizeTokenUsage } from '../models'
import { isScriptedModelEnabled } from '../models/scripted'
import {
  CAMPAIGN_STUDIO_INSTRUCTIONS,
  DESIGN_STUDIO_INSTRUCTIONS,
  formatCampaignStudioBrief,
} from '../prompts/campaign-studio'
import { type CampaignStudioRecord, createCampaignStudioTools } from '../tools/campaign-studio'
import { createDesignStudioTools } from '../tools/design-studio'
import { createToolRun, flushToolRun, isRunStopped } from '../tools/executor'
import { getWorkspaceVoice } from '@/lib/launch/store'
import { voiceInstructions } from '@/lib/write/voice'

const MAX_STEPS = 14
/** Design runs explore templates and variants, so they get more steps. */
const MAX_DESIGN_STEPS = 32

export function isCampaignStudioConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY) || isScriptedModelEnabled()
}

/** Registered product and release URLs the agent may capture, in priority order. */
function getCaptureUrls(urls: Array<string | null | undefined>): string[] {
  const allowed: string[] = []
  for (const url of urls) {
    if (!url || allowed.includes(url)) continue
    try {
      assertPublicCaptureUrl(url)
      allowed.push(url)
    } catch {
      // Private or malformed URLs are skipped, never captured.
    }
  }
  return allowed.slice(0, 5)
}

/**
 * Generate a launch kit for one campaign: product captures, composited
 * product shots, and draft posts, all attached to the campaign for review.
 * Runs inside the caller's tenant context with the caller's role, every tool
 * call and write is audited, and the run stops when `signal` aborts.
 */
export async function runCampaignStudio(
  tenant: OrganizationAccess,
  campaignId: string,
  signal?: AbortSignal
) {
  const campaign = await getCampaign(tenant, campaignId)
  if (!campaign) throw new CampaignError('Campaign not found.', 404)
  if (!campaign.release) {
    throw new CampaignError('Link a release brief before generating a launch kit.', 409)
  }
  const sourceUrls = campaign.release.sourceUrls ?? []
  const captureUrls = getCaptureUrls([campaign.productSurface?.url, ...sourceUrls])
  if (captureUrls.length === 0) {
    throw new CampaignError('Connect a public product URL before generating a launch kit.', 409)
  }

  const record: CampaignStudioRecord = { assets: [], savedPosts: 0 }
  const modelId = models.modelId('deep')
  const run = createToolRun({
    access: tenant,
    audit: (event) => backendSDK(tenant).appendAuditEvent(event),
    signal,
  })
  const scope = {
    allowedUrls: captureUrls as [string, ...string[]],
    campaignId: campaign.id,
    run,
    tenant,
  }
  const baseTools = createCampaignStudioTools(scope, record)
  // Design mode needs the renderer; if it is down, the run still produces
  // visuals with sharp product shots instead of failing.
  const designMode = await isDesignRendererReady()
  // One browser per run, started on the first render and closed when the run ends.
  let renderer: Promise<DesignRenderer> | null = null
  const getRenderer = () => (renderer ??= createDesignRenderer())
  const tools = designMode
    ? {
        captureProductPage: baseTools.captureProductPage,
        // Kept as a fallback for renders that fail mid-run.
        createProductShot: baseTools.createProductShot,
        saveCampaignCopy: baseTools.saveCampaignCopy,
        ...createDesignStudioTools(scope, record, getRenderer),
      }
    : baseTools

  const result = await generateText({
    abortSignal: signal,
    model: models.languageModel('deep'),
    prompt: formatCampaignStudioBrief({
      audience: campaign.release.audience ?? campaign.audience,
      benefitStatement: campaign.release.benefitStatement,
      campaignName: campaign.name,
      description: campaign.release.description,
      objective: campaign.objective,
      product: campaign.productSurface,
      sourceUrls,
      title: campaign.release.title,
    }),
    stopWhen: [stepCountIs(designMode ? MAX_DESIGN_STEPS : MAX_STEPS), isRunStopped(run)],
    system:
      (designMode ? DESIGN_STUDIO_INSTRUCTIONS : CAMPAIGN_STUDIO_INSTRUCTIONS) +
      voiceInstructions(await getWorkspaceVoice(tenant)),
    tools,
  }).finally(async () => {
    if (renderer) await (await renderer).close().catch(() => undefined)
    await flushToolRun(run)
  })

  const usage = normalizeTokenUsage(result.totalUsage)
  await backendSDK(tenant).appendAuditEvent({
    action: 'product.campaign_generated',
    entityId: campaign.id,
    entityType: 'campaign',
    metadata: {
      assetCount: record.assets.length,
      // Not "...Tokens": the audit sanitizer redacts any key matching /token/.
      inputUsage: usage.inputTokens,
      modelId,
      outputUsage: usage.outputTokens,
      designMode,
      postCount: record.savedPosts,
      steps: result.steps.length,
    },
  })
  return {
    assets: record.assets,
    postCount: record.savedPosts,
    summary: result.text,
  }
}
