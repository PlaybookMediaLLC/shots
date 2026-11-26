import 'server-only'

import { type ModelMessage, stepCountIs, streamText } from 'ai'
import { isCampaignStudioConfigured } from '@/lib/ai/agents/campaign-studio'
import { withAiCredits } from '@/lib/ai/metering'
import { models } from '@/lib/ai/models'
import {
  EDITOR_COPILOT_INSTRUCTIONS,
  STORE_COPILOT_INSTRUCTIONS,
  SURFACE_COPILOT_INSTRUCTIONS,
  scopeInstructions,
} from '@/lib/ai/prompts/editor-copilot'
import { productContext } from '@/lib/ai/assistant/product-context'
import { WORKSPACE_ASSISTANT_INSTRUCTIONS } from '@/lib/ai/prompts/workspace-assistant'
import { createEditorCopilotTools, editorClientToolNames } from '@/lib/ai/tools/editor-copilot'
import { createToolRun, flushToolRun, isRunStopped } from '@/lib/ai/tools/executor'
import {
  type AssistantTurnState,
  workspaceAssistantTools,
} from '@/lib/ai/tools/workspace-assistant'
import { ASSISTANT_POSTS_MAX, type AssistantProgress } from '@/lib/api/contracts/ai'
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
import { isAiEnabled } from '@/lib/trpc/routers/launch'
import { voiceInstructions } from '@/lib/write/voice'

/** Model steps one HTTP round-trip may take before returning to the browser. */
const MAX_STEPS = 6

/** Maximum assistant steps within one user turn across client-tool round-trips. */
const MAX_STEPS_PER_TURN = 16

const KNOWN_CLIENT_TOOLS = new Set<string>(editorClientToolNames)

/** The surface tools this caller may use: known names, and only for a member who may edit. */
export function surfaceTools(access: OrganizationAccess, asked: readonly string[]) {
  return accessAllows(access, 'artifact:edit')
    ? asked.filter((name) => KNOWN_CLIENT_TOOLS.has(name))
    : []
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
    messages,
    page,
    selection = null,
    signal,
    onEvent,
  }: {
    /** Hears the reply and each tool step while the model works. */
    onEvent?: (event: AssistantProgress) => void
    clientTools?: string[]
    messages: ModelMessage[]
    page: PageContext
    selection?: string | null
    signal?: AbortSignal
  }
) {
  if (!isCampaignStudioConfigured()) throw new AssistantRefusal('AI is not configured.', 503)
  if (!(await isAiEnabled(access)))
    throw new AssistantRefusal('AI is turned off for this workspace.', 403)

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

  const backend = backendSDK(access)
  const run = createToolRun({ access, audit: (event) => backend.appendAuditEvent(event), signal })
  // The page's own address is always offerable; the rest must come from a tool.
  const state: AssistantTurnState = { known: new Set([page.path]), links: [], posts: [] }

  const workspaceTools = workspaceAssistantTools(run, state)
  const tools = hasSurfaceTools
    ? { ...workspaceTools, ...createEditorCopilotTools(activeClientTools) }
    : workspaceTools

  // Posts and on-surface text are both public copy, so every turn carries the voice.
  const [voice, product] = await Promise.all([
    turnVoice(access, page).catch(() => null),
    productContext(access),
  ])
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
  if (product) systemParts.push(product)
  systemParts.push(describePage(page))

  try {
    return await withAiCredits(access, async () => {
      const started = Date.now()
      const result = streamText({
        abortSignal: signal,
        messages: trimSnapshots(messages),
        model: models.languageModel('drafting'),
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
        inputTokens: steps.reduce((sum, step) => sum + (step.usage.inputTokens ?? 0), 0),
        ms: Date.now() - started,
        organizationId: access.organizationId,
        outputTokens: steps.reduce((sum, step) => sum + (step.usage.outputTokens ?? 0), 0),
        steps: steps.length,
        surface: page.surface ?? 'none',
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
    })
  } finally {
    await flushToolRun(run)
  }
}
