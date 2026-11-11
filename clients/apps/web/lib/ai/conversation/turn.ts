import 'server-only'

import { asSchema, generateText, stepCountIs } from 'ai'
import { after } from 'next/server'
import type {
  BackendAgentRun,
  BackendConversation,
  BackendConversationMessage,
} from 'screenshot-studio-backend-sdk'
import { z } from 'zod'
import { formatBrandKit, formatProductProfile } from '@/lib/ai/launch/context'
import { withAiCredits } from '@/lib/ai/metering'
import { models, normalizeTokenUsage } from '@/lib/ai/models'
import {
  createToolRun,
  type DefinedTool,
  flushToolRun,
  isRunStopped,
} from '@/lib/ai/tools/executor'
import type { OrganizationAccess } from '@/lib/auth/access'
import { backendSDK } from '@/lib/backend/sdk'
import { isRunStale } from '@/lib/launch/run-lease'
import { keepRunAlive } from '@/lib/launch/runs'
import { defuseMarkup } from '@/lib/launch/sanitize'
import { getActiveBrand, LaunchError } from '@/lib/launch/store'
import { postLength } from '@/lib/launch/post-edit'
import { CHANNEL_RULES } from '@/lib/launch/guards'
import type { LaunchChannel } from '@/lib/launch/spec-schema'
import { getCampaign } from '@/lib/tenant/campaigns'
import { getProductProfile } from '@/lib/tenant/product-profile'
import { buildTurnContext, mayAskClarification } from './context'
import { describeStep, isRetryableStep, type StepView } from './steps'
import { conversationTools, type TurnState } from './tools'
import { voiceInstructions } from '@/lib/write/voice'

/**
 * One durable, non-streaming conversation turn (RFC 028, rollout step 1).
 *
 * The user's message persists first. A conversation run starts, a `tool`
 * message anchors it in the conversation so a reload finds it, and the agent
 * works after the response (`after`), heartbeating like the launch runs, so a
 * closed tab does not stop it. Each tool call is a trace step on the run. The
 * assistant's reply is written before the run finishes, so the UI, which
 * polls the database, sees both together.
 */

/** Model steps one turn may take. */
const MAX_STEPS = 12
/** Runs whose trace `getConversationView` loads, newest first. */
const TRACED_RUNS = 10
/** The backend's title for a conversation created without one. */
const DEFAULT_TITLE = 'New conversation'

const MODEL_UNREACHABLE = 'I could not reach the model. Retry.'
const NO_PRODUCT =
  'I need to know your product before I can market it. Add your product using the button below, then tell me what you shipped.'
const STEP_CAP =
  'I reached this turn’s step limit. Everything made so far is kept; send another message to continue.'
const LOOPED = 'I repeated a step and stopped. Everything made so far is kept.'
const STOPPED = 'The run stopped before it finished.'

/** What a person can do from an assistant message. */
export const messageActionSchema = z.enum([
  /** Add the product profile. */
  'onboarding',
  /** Send the previous message again; the model was unreachable. */
  'resend',
])
/** What a person can do from an assistant message. */
export type MessageAction = z.infer<typeof messageActionSchema>

const messageMetadataSchema = z.object({ action: messageActionSchema })

const clip = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`

/** A RUNNING run whose lease lapsed counts as stopped. */
function runStatus(run: BackendAgentRun): {
  error: string | null
  status: BackendAgentRun['status']
} {
  const stale =
    run.status === 'RUNNING' &&
    isRunStale({
      heartbeatAt: run.heartbeatAt ? new Date(run.heartbeatAt) : null,
      startedAt: new Date(run.startedAt),
    })
  return stale ? { error: STOPPED, status: 'FAILED' } : { error: run.error, status: run.status }
}

/** The linked campaign's structure, for the agent's context. */
function formatCampaign(campaign: Awaited<ReturnType<typeof getCampaign>>): string | null {
  if (!campaign) return null
  const text = (value: string | null | undefined, max = 120) =>
    defuseMarkup(clip((value ?? '').replace(/\s+/g, ' ').trim(), max))
  return [
    '<campaign>',
    `Name: ${text(campaign.name)}`,
    `Status: ${campaign.status}`,
    campaign.angles.length
      ? `Angles:\n${campaign.angles.map((angle) => `- ${text(angle.title)}`).join('\n')}`
      : 'Angles: none yet',
    campaign.posts.length
      ? `Posts (id, channel, status, character count including CTA, opening):\n${campaign.posts
          .slice(0, 30)
          .map(
            (post) =>
              `- ${post.id} ${post.channel} ${post.status} ${postLength(post.copy, post.callToAction)}/${CHANNEL_RULES[post.channel as LaunchChannel]?.bodyMax ?? 3000} characters: ${text(post.copy, 80)}`
          )
          .join('\n')}`
      : 'Posts: none yet',
    `Visuals: ${campaign.assets.length}`,
    '</campaign>',
  ].join('\n')
}

/** The newest run the conversation references, if it is still running. */
async function activeRun(
  access: OrganizationAccess,
  messages: readonly BackendConversationMessage[]
): Promise<string | null> {
  const runId = messages.findLast((message) => message.launchRunId)?.launchRunId
  if (!runId) return null
  const run = await backendSDK(access).getAgentRun(runId)
  return runStatus(run).status === 'RUNNING' ? run.id : null
}

/**
 * Send a message: persist it, start the conversation run, and answer after
 * the response. A conversation in another workspace is not found.
 */
export async function runTurn(
  access: OrganizationAccess,
  input: { content: string; conversationId: string }
): Promise<{ messageId: string; runId: string }> {
  const backend = backendSDK(access)
  const { conversation, messages } = await backend.getConversation(input.conversationId)
  if (await activeRun(access, messages)) {
    throw new LaunchError('Wait for the current turn to finish, or cancel it.', 409)
  }
  // First, so the message is kept whatever happens to the run.
  const message = await backend.appendConversationMessage(conversation.id, {
    content: input.content,
    kind: 'text',
    role: 'user',
  })
  if (messages.length === 0 && conversation.title === DEFAULT_TITLE) {
    // The title comes from the first message; only the author or an admin may rename.
    await backend
      .updateConversation(conversation.id, { title: clip(input.content, 80) })
      .catch(() => undefined)
  }
  const run = await backend.startAgentRun({
    campaignId: conversation.campaignId,
    kind: 'conversation',
  })
  // The run's place in the conversation, so a reload finds it while it runs.
  await backend.appendConversationMessage(conversation.id, {
    content: 'Agent run',
    kind: 'tool',
    launchRunId: run.id,
    role: 'tool',
  })
  after(() => executeTurn(access, { conversation, history: [...messages, message], runId: run.id }))
  return { messageId: message.id, runId: run.id }
}

async function executeTurn(
  access: OrganizationAccess,
  input: {
    conversation: BackendConversation
    history: BackendConversationMessage[]
    runId: string
  }
): Promise<void> {
  const { conversation, history, runId } = input
  const backend = backendSDK(access)
  const reply = (content: string, kind: 'clarification' | 'text', action?: MessageAction) =>
    backend.appendConversationMessage(conversation.id, {
      content: clip(content, 20_000),
      kind,
      launchRunId: runId,
      metadata: action ? { action } : undefined,
      role: 'assistant',
    })
  const abort = new AbortController()
  const stopHeartbeat = keepRunAlive(access, runId, abort)
  const toolRun = createToolRun({
    access,
    audit: (event) => backend.appendAuditEvent(event),
    launchRunId: runId,
    recordStep: (step) => backend.appendLaunchRunStep(runId, step),
    signal: abort.signal,
  })
  let modelCalled = false
  try {
    const [profile, brand, campaign, { productSurfaces }] = await Promise.all([
      getProductProfile(access),
      getActiveBrand(access),
      conversation.campaignId ? getCampaign(access, conversation.campaignId) : null,
      backend.listProductSurfaces(),
    ])
    if (!profile && !campaign && productSurfaces.length === 0) {
      // No question: the agent cannot market a product it does not know.
      await reply(NO_PRODUCT, 'text', 'onboarding')
      await backend.finishLaunchRun(runId, { status: 'FAILED', error: NO_PRODUCT, stepCount: 0 })
      return
    }
    const state: TurnState = {
      campaignId: campaign?.id ?? null,
      clarification: null,
      conversationId: conversation.id,
    }
    const { messages, system } = buildTurnContext({
      context: [
        formatProductProfile(profile),
        productSurfaces.length
          ? `<registered_products>
${productSurfaces
  .map(
    (surface) =>
      `${defuseMarkup(surface.name)} (${defuseMarkup(surface.slug)}): ${defuseMarkup(surface.url)} — ${defuseMarkup(surface.description ?? '')}`
  )
  .join('\n')}
</registered_products>`
          : null,
        voiceInstructions(brand.voice),
        formatBrandKit(brand.kit),
        formatCampaign(campaign),
      ],
      history,
    })
    modelCalled = true
    const result = await withAiCredits(access, () =>
      generateText({
        abortSignal: abort.signal,
        messages,
        model: models.languageModel('drafting'),
        stopWhen: [
          stepCountIs(MAX_STEPS),
          isRunStopped(toolRun),
          () => state.clarification !== null,
        ],
        system,
        tools: conversationTools(toolRun, state, { canAsk: mayAskClarification(history) }),
      })
    )
    await flushToolRun(toolRun)
    const looped = toolRun.stopReason === 'LOOP_DETECTED'
    const capped =
      !looped &&
      !state.clarification &&
      result.steps.length >= MAX_STEPS &&
      result.finishReason === 'tool-calls'
    const text = result.text.trim()
    if (state.clarification) {
      const { options, question } = state.clarification
      await reply([question, ...options.map((option) => `- ${option}`)].join('\n'), 'clarification')
    } else {
      const ending = looped ? LOOPED : capped ? STEP_CAP : null
      await reply([text, ending].filter(Boolean).join('\n\n') || 'Done.', 'text')
    }
    const usage = normalizeTokenUsage(result.totalUsage)
    await backend.finishLaunchRun(runId, {
      ...(looped
        ? { error: LOOPED, status: 'FAILED' as const }
        : { status: capped ? ('BUDGET_EXHAUSTED' as const) : ('SUCCEEDED' as const) }),
      resultId: state.campaignId,
      stepCount: result.steps.reduce((count, step) => count + step.toolCalls.length, 0),
      summary: text.slice(0, 2_000) || null,
      tokensIn: usage.inputTokens ?? 0,
      tokensOut: usage.outputTokens ?? 0,
    })
  } catch (error) {
    await flushToolRun(toolRun)
    if (abort.signal.aborted) {
      // Cancelled: the backend already finished the run; what was made stays.
      await reply('Cancelled. Everything made before that is kept.', 'text').catch(() => undefined)
      return
    }
    console.error('Conversation turn failed.', {
      reason: error instanceof Error ? error.message : 'unknown',
      runId,
    })
    const message = modelCalled
      ? MODEL_UNREACHABLE
      : 'Something went wrong before I started. Retry.'
    await reply(message, 'text', 'resend').catch(() => undefined)
    await backend
      .finishLaunchRun(runId, { error: message, status: 'FAILED' })
      .catch(() => undefined)
  } finally {
    stopHeartbeat()
  }
}

/**
 * Retry one failed step: re-run only its tool, with its recorded input, on
 * the same run, after the response. The result appends a new step; the
 * failed one stays in the trace.
 */
export async function retryStep(
  access: OrganizationAccess,
  input: { conversationId: string; runId: string; stepId: string }
): Promise<{ retrying: true }> {
  const backend = backendSDK(access)
  const { conversation, messages } = await backend.getConversation(input.conversationId)
  if (!messages.some((message) => message.launchRunId === input.runId)) {
    throw new LaunchError('Run not found.', 404)
  }
  const run = await backend.getAgentRun(input.runId)
  if (runStatus(run).status === 'RUNNING') {
    throw new LaunchError('Wait for the turn to finish.', 409)
  }
  const { steps } = await backend.listLaunchRunSteps(run.id)
  const step = steps.find((entry) => entry.id === input.stepId)
  if (!step) throw new LaunchError('Step not found.', 404)
  if (!isRetryableStep(step, steps)) throw new LaunchError('This step cannot be retried.', 409)

  const toolRun = createToolRun({
    access,
    audit: (event) => backend.appendAuditEvent(event),
    launchRunId: run.id,
    recordStep: (entry) => backend.appendLaunchRunStep(run.id, entry),
  })
  // The retry is the run's next step, after every recorded one.
  toolRun.stepIndex = Math.max(...steps.map((entry) => entry.index)) + 1
  const state: TurnState = {
    campaignId: conversation.campaignId,
    clarification: null,
    conversationId: conversation.id,
  }
  const tools = conversationTools(toolRun, state, { canAsk: false }) as Record<
    string,
    DefinedTool<unknown, unknown> | undefined
  >
  const tool = step.toolName ? tools[step.toolName] : undefined
  const parsed = tool && (await asSchema(tool.inputSchema).validate?.(step.inputSummary ?? {}))
  if (!tool || !parsed?.success) {
    throw new LaunchError(
      'This step’s input was not recorded in full. Send a message instead.',
      409
    )
  }
  const label = describeStep(step, steps).label
  after(async () => {
    try {
      const result = await withAiCredits(access, () =>
        tool.execute(parsed.value, { context: {}, messages: [], toolCallId: `retry-${step.id}` })
      )
      await flushToolRun(toolRun)
      const ok = (result as { ok?: unknown } | null)?.ok !== false
      await backend.appendConversationMessage(conversation.id, {
        content: ok ? `I retried “${label}”. It worked.` : `I retried “${label}”. It failed again.`,
        kind: 'text',
        launchRunId: run.id,
        role: 'assistant',
      })
    } catch (error) {
      console.error('Step retry failed.', {
        reason: error instanceof Error ? error.message : 'unknown',
        runId: run.id,
      })
    }
  })
  return { retrying: true }
}

/** A run as the conversation panel shows it. */
export type ConversationRunView = {
  error: string | null
  id: string
  status: BackendAgentRun['status']
  steps: StepView[]
}

/**
 * A conversation with its messages, and the status and trace of each run
 * they reference (the newest ten). Message content is returned as stored;
 * the UI renders it as text.
 */
export async function getConversationView(access: OrganizationAccess, conversationId: string) {
  const backend = backendSDK(access)
  const { conversation, messages } = await backend.getConversation(conversationId)
  const runIds = [
    ...new Set(messages.flatMap((message) => (message.launchRunId ? [message.launchRunId] : []))),
  ].slice(-TRACED_RUNS)
  // ponytail: two backend reads per traced run on every poll; a batch read when it shows.
  const runs = await Promise.all(
    runIds.map(async (id): Promise<ConversationRunView> => {
      const [run, { steps }] = await Promise.all([
        backend.getAgentRun(id),
        backend.listLaunchRunSteps(id),
      ])
      return { ...runStatus(run), id, steps: steps.map((step) => describeStep(step, steps)) }
    })
  )
  return {
    conversation: {
      campaignId: conversation.campaignId,
      id: conversation.id,
      status: conversation.status,
      title: conversation.title,
    },
    messages: messages.map((message) => ({
      action: messageMetadataSchema.safeParse(message.metadata).data?.action ?? null,
      content: message.role === 'tool' ? '' : message.content,
      createdAt: message.createdAt,
      id: message.id,
      kind: message.kind,
      launchRunId: message.launchRunId,
      role: message.role,
    })),
    runs,
  }
}

/** Cancel a running turn; it stops after its current tool call. */
export async function cancelTurn(access: OrganizationAccess, runId: string) {
  return backendSDK(access).cancelLaunchRun(runId)
}
