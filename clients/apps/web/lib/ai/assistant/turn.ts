import 'server-only'

import { APICallError, type ModelMessage, stepCountIs, streamText } from 'ai'
import { isCampaignStudioConfigured } from '@/lib/ai/agents/campaign-studio'
import { withAiCredits } from '@/lib/ai/metering'
import { models } from '@/lib/ai/models'
import {
  type AiEffort,
  type AiModelTier,
  parseWorkspaceAiDefaults,
  resolveEffectivePreference,
  surfaceToAiSlot,
  tierRequiresApiKey,
} from '@/lib/ai/models/tiers'
import {
  EDITOR_COPILOT_INSTRUCTIONS,
  STORE_COPILOT_INSTRUCTIONS,
  SURFACE_COPILOT_INSTRUCTIONS,
  scopeInstructions,
} from '@/lib/ai/prompts/editor-copilot'
import {
  pinnedContextBlock,
  productContext,
  workspaceInstructionsBlock,
} from '@/lib/ai/assistant/product-context'
import { WORKSPACE_ASSISTANT_INSTRUCTIONS } from '@/lib/ai/prompts/workspace-assistant'
import {
  createEditorCopilotTools,
  editorClientToolNames,
  editorCopilotCapabilities,
} from '@/lib/ai/tools/editor-copilot'
import { createToolRun, flushToolRun, isRunStopped } from '@/lib/ai/tools/executor'
import {
  type AssistantTurnState,
  workspaceAssistantTools,
} from '@/lib/ai/tools/workspace-assistant'
import {
  ASSISTANT_POSTS_MAX,
  type AssistantContextRef,
  type AssistantProgress,
} from '@/lib/api/contracts/ai'
import { ASSISTANT_AI_RATE_LIMIT } from '@/lib/api/rate-limit-policy'
import { describePage, type PageContext } from '@/lib/assistant/page-context'
import { trimSnapshots } from '@/lib/assistant/snapshots'
import type { OrganizationAccess } from '@/lib/auth/access'
import { accessAllows } from '@/lib/auth/permissions'
import { backendSDK } from '@/lib/backend/sdk'
import { getWorkspaceVoice } from '@/lib/launch/store'
import { writingContext } from '@/lib/write/ai-route'
import { draftChannelSchema } from '@/lib/write/document'
import { checkRateLimit } from '@/lib/rate-limit'
import { voiceInstructions } from '@/lib/write/voice'

/** Model steps one HTTP round-trip may take before returning to the browser. */
const MAX_STEPS = 6

/** Maximum assistant steps within one user turn across client-tool round-trips. */
const MAX_STEPS_PER_TURN = 16

const BYOK_REQUIRED_MESSAGE =
  'Claude Sonnet 5.5 and Claude Opus 5.5 require your own OpenRouter API key. Add one in Settings → Models & usage.'

const BYOK_KEY_REJECTED_MESSAGE =
  'Your workspace OpenRouter API key was rejected or has insufficient credits. Check it in Settings → Models & usage.'

function isByokProviderAuthFailure(error: unknown): boolean {
  const candidates: unknown[] = [error]
  if (error && typeof error === 'object') {
    if ('cause' in error) candidates.push((error as { cause?: unknown }).cause)
    if ('lastError' in error) candidates.push((error as { lastError?: unknown }).lastError)
  }
  return candidates.some(
    (candidate) =>
      APICallError.isInstance(candidate) &&
      (candidate.statusCode === 401 ||
        candidate.statusCode === 402 ||
        candidate.statusCode === 403)
  )
}

const KNOWN_CLIENT_TOOLS = new Set<string>(editorClientToolNames)

/** The surface tools this caller may use: each tool checked against its RFC 027 permission. */
export function surfaceTools(access: OrganizationAccess, asked: readonly string[]) {
  return asked.filter((name) => {
    if (!KNOWN_CLIENT_TOOLS.has(name)) return false
    const capability = editorCopilotCapabilities[name as keyof typeof editorCopilotCapabilities]
    return Boolean(capability && accessAllows(access, capability.permission))
  })
}

/**
 * The voice this turn writes in: on a post draft, the draft's own (its publishing
 * profile's, for the platform on screen) when the caller can see it, else the
 * workspace's.
 */
async function turnVoice(access: OrganizationAccess, page: PageContext) {
  if (page.surface === 'write-composer') {
    const draft = page.entities.find((entity) => entity.type === 'draft')?.id
    const channel = draftChannelSchema.safeParse(
      page.entities.find((entity) => entity.type === 'channel')?.id
    )
    if (draft && channel.success) {
      const voice = await writingContext(access, draft, channel.data)
      if (voice) return voice
    }
  }
  return getWorkspaceVoice(access)
}

/** Why a turn cannot start, with the status the route answers. */
export class AssistantRefusal extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 429 | 503
  ) {
    super(message)
    this.name = 'AssistantRefusal'
  }
}

/**
 * One step of the unified Shots assistant: the person's conversation, the page
 * they are on, and any client-executed tools the active editing surface exposes.
 *
 * Workspace tools run on the server through the RFC 027 executor (with RBAC,
 * call caps, timeouts and audit logging). When an editing surface is active and
 * the caller has `artifact:edit`, surface tools are composed into the same turn;
 * if the model calls a client-executed tool, the route returns `done: false` and
 * `pendingToolCalls` for the browser to apply and send back.
 */
export async function runWorkspaceAssistantTurn(
  access: OrganizationAccess,
  {
    clientTools = [],
    contextRefs = [],
    effort,
    messages,
    modelTier,
    page,
    selection = null,
    signal,
    onEvent,
  }: {
    /** Hears the reply and each tool step while the model works. */
    onEvent?: (event: AssistantProgress) => void
    clientTools?: string[]
    contextRefs?: AssistantContextRef[]
    effort?: AiEffort
    messages: ModelMessage[]
    modelTier?: AiModelTier
    page: PageContext
    selection?: string | null
    signal?: AbortSignal
  }
) {
  const backend = backendSDK(access)
  const [paidDecision, workspace] = await Promise.all([
    backend.getFeatureDecision('workspace:paid'),
    backend.getWorkspace(),
  ])
  if (!paidDecision.allowed || workspace.workspace?.workspaceSettings?.aiAgentEnabled === false) {
    throw new AssistantRefusal('AI is turned off for this workspace.', 403)
  }

  const wsDefaults = parseWorkspaceAiDefaults(workspace.workspace?.workspaceSettings?.aiModelDefaults)
  const resolved = resolveEffectivePreference(wsDefaults, surfaceToAiSlot(page.surface))
  const effectiveTier = modelTier ?? resolved.tier
  const effectiveEffort = effort ?? resolved.effort
  const providerEffort =
    effectiveTier === 'fast' && effectiveEffort !== 'high' ? undefined : effectiveEffort
  const needsByok = tierRequiresApiKey(effectiveTier)
  if (needsByok) {
    if (!workspace.workspace?.workspaceSettings?.hasAiProviderKey) {
      throw new AssistantRefusal(BYOK_REQUIRED_MESSAGE, 403)
    }
  } else if (!isCampaignStudioConfigured()) {
    throw new AssistantRefusal('AI is not configured.', 503)
  }

  const lastRole = messages.at(-1)?.role
  if (lastRole !== 'user' && lastRole !== 'tool') {
    throw new AssistantRefusal('End with a user or tool message.', 400)
  }
  const lastUser = messages.findLastIndex((message) => message.role === 'user')
  if (lastUser < 0) throw new AssistantRefusal('A user message is required.', 400)

  const stepsThisTurn = messages
    .slice(lastUser)
    .filter((message) => message.role === 'assistant').length
  if (stepsThisTurn >= MAX_STEPS_PER_TURN) {
    return {
      done: true,
      links: [],
      messages: [],
      pendingToolCalls: [],
      posts: [],
      text: 'I stopped here to avoid going in circles. Tell me what to adjust next.',
      toolSteps: [],
    }
  }

  // Every round trip counts: the caller owns the history, so its shape proves nothing.
  const limit = await checkRateLimit(`assistant-ai:${access.organizationId}`, ASSISTANT_AI_RATE_LIMIT)
  if (!limit.allowed) {
    throw new AssistantRefusal('Too many AI requests. Wait a minute and try again.', 429)
  }

  const activeClientTools = surfaceTools(access, clientTools)
  const hasSurfaceTools = activeClientTools.length > 0
  const activeSelection = selection ?? page.selection ?? null

  const run = createToolRun({ access, audit: (event) => backend.appendAuditEvent(event), signal })
  // The page's own address is always offerable; the rest must come from a tool.
  const state: AssistantTurnState = { known: new Set([page.path]), links: [], posts: [] }

  const workspaceTools = workspaceAssistantTools(run, state)
  const tools = hasSurfaceTools
    ? { ...workspaceTools, ...createEditorCopilotTools(activeClientTools) }
    : workspaceTools

  // Posts and on-surface text are both public copy, so every turn carries the voice.
  const [voice, product, pinned, byokResult] = await Promise.all([
    turnVoice(access, page).catch(() => null),
    productContext(access),
    pinnedContextBlock(access, contextRefs),
    needsByok ? backend.getWorkspaceAiProviderKey() : Promise.resolve({ apiKey: null }),
  ])
  const byokApiKey = byokResult.apiKey?.trim() || undefined
  if (needsByok && !byokApiKey) {
    throw new AssistantRefusal(BYOK_REQUIRED_MESSAGE, 403)
  }

  const systemParts: string[] = [WORKSPACE_ASSISTANT_INSTRUCTIONS]
  if (hasSurfaceTools) {
    if (page.surface === 'store-screenshots') {
      systemParts.push(STORE_COPILOT_INSTRUCTIONS)
    } else if (page.surface !== 'screenshot-editor' && page.surface !== 'canvas') {
      systemParts.push(SURFACE_COPILOT_INSTRUCTIONS)
    } else {
      systemParts.push(EDITOR_COPILOT_INSTRUCTIONS + scopeInstructions(activeSelection))
    }
  }
  const voiceBlock = voiceInstructions(voice)
  if (voiceBlock) systemParts.push(voiceBlock)
  const instructionsBlock = workspaceInstructionsBlock(
    workspace?.workspace?.workspaceSettings?.aiInstructions
  )
  if (instructionsBlock) systemParts.push(instructionsBlock)
  if (product) systemParts.push(product)
  if (pinned) systemParts.push(pinned)
  systemParts.push(describePage(page))

  const executeTurn = async () => {
    const started = Date.now()
    const result = streamText({
      abortSignal: signal,
      messages: trimSnapshots(messages),
      model: models.tieredModel(effectiveTier, providerEffort, byokApiKey),
      stopWhen: [stepCountIs(MAX_STEPS), isRunStopped(run)],
      system: systemParts.join('\n\n'),
      tools,
      // The stream below carries the error; the default handler would only log it.
      onError: () => {},
    })
    for await (const part of result.fullStream) {
      if (part.type === 'error') throw part.error
      if (part.type === 'text-delta') onEvent?.({ text: part.text, type: 'text' })
      if (part.type === 'tool-call') onEvent?.({ name: part.toolName, type: 'tool' })
    }
    const [calls, steps, response, text] = await Promise.all([
      result.toolCalls,
      result.steps,
      result.response,
      result.text,
    ])

    const activeClientSet = new Set(activeClientTools)
    const pendingToolCalls = calls
      .filter((call) => activeClientSet.has(call.toolName))
      .map((call) => ({
        input: call.input,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
      }))

    const toolSteps: string[] = []
    for (const step of steps) {
      for (const call of step.toolCalls) {
        if (!toolSteps.includes(call.toolName)) toolSteps.push(call.toolName)
      }
    }

    // Counts only: never the person's words or the model's.
    console.warn('Assistant turn.', {
      byok: Boolean(byokApiKey),
      inputTokens: steps.reduce((sum, step) => sum + (step.usage.inputTokens ?? 0), 0),
      ms: Date.now() - started,
      organizationId: access.organizationId,
      outputTokens: steps.reduce((sum, step) => sum + (step.usage.outputTokens ?? 0), 0),
      steps: steps.length,
      surface: page.surface ?? 'none',
      tier: effectiveTier,
      tools: toolSteps,
    })

    return {
      done: pendingToolCalls.length === 0,
      links: state.links,
      messages: response.messages,
      pendingToolCalls,
      posts: state.posts.slice(0, ASSISTANT_POSTS_MAX),
      text,
      toolSteps,
    }
  }

  try {
    return byokApiKey ? await executeTurn() : await withAiCredits(access, executeTurn)
  } catch (error) {
    if (byokApiKey && isByokProviderAuthFailure(error)) {
      throw new AssistantRefusal(BYOK_KEY_REJECTED_MESSAGE, 403)
    }
    throw error
  } finally {
    await flushToolRun(run)
  }
}
