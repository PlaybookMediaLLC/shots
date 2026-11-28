import 'server-only'

import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  type LanguageModel,
  Output,
  streamText,
  type UIMessage,
} from 'ai'
import { z } from 'zod'
import { withAiCredits } from '@/lib/ai/metering'
import { models } from '@/lib/ai/models'
import { productContext } from '@/lib/ai/assistant/product-context'
import {
  DOCUMENT_COPILOT_INSTRUCTIONS,
  DOCUMENT_EDITOR_INSTRUCTIONS,
  DOCUMENT_REVIEW_INSTRUCTIONS,
} from '@/lib/ai/prompts/document-editor'
import {
  type documentChatRequestSchema,
  type documentCopilotRequestSchema,
  documentReviewCommentSchema,
  type documentVoiceQuerySchema,
} from '@/lib/api/contracts/ai'
import {
  EDITOR_COPILOT_RATE_LIMIT,
  EDITOR_COPILOT_USER_RATE_LIMIT,
  type RateLimitPolicy,
} from '@/lib/api/rate-limit-policy'
import { errorResponse } from '@/lib/api/route'
import { trimMessagesToBudget } from '@/lib/assistant/snapshots'
import type { OrganizationAccess } from '@/lib/auth/access'
import { getWorkspaceVoice } from '@/lib/launch/store'
import { writingContext } from '@/lib/write/ai-route'
import { CAPABILITIES } from '@/lib/write/capabilities'
import { voiceInstructions } from '@/lib/write/voice'

type DocumentChatRequest = z.infer<typeof documentChatRequestSchema>
type DocumentVoiceQuery = z.infer<typeof documentVoiceQuerySchema>

/**
 * The voice the editor's AI writes in: the draft's (its social set's, for the
 * channel being edited) when the caller can see that draft, else the
 * workspace's. It starts loading at once and is awaited inside the credit scope.
 */
export function documentVoice(access: OrganizationAccess, query: DocumentVoiceQuery) {
  const voice = (async () =>
    (query.channel ? await writingContext(access, query.draftId, query.channel) : null) ??
    getWorkspaceVoice(access))()
  voice.catch(() => undefined)
  return voice
}

/** Maximum output tokens for one inline ghost-text continuation. */
const COPILOT_MAX_OUTPUT_TOKENS = 80

const COPILOT_CONTEXT_TTL_MS = 60_000
const COPILOT_CONTEXT_MAX_ENTRIES = 500

type CachedCopilotContext = {
  expiresAt: number
  value: string
}

const copilotContextCache = new Map<string, CachedCopilotContext>()
const copilotContextInFlight = new Map<string, Promise<string>>()

/** Clears cached copilot voice/product prompts (for tests). */
export function clearCopilotContextCache(): void {
  copilotContextCache.clear()
  copilotContextInFlight.clear()
}

function copilotContextCacheKey(access: OrganizationAccess, query: DocumentVoiceQuery): string {
  return `${access.organizationId}:${access.principal.userId}:${query.draftId ?? ''}:${query.channel ?? ''}`
}

function readCachedCopilotContext(key: string): string | null {
  const entry = copilotContextCache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    copilotContextCache.delete(key)
    return null
  }
  // Refresh LRU recency.
  copilotContextCache.delete(key)
  copilotContextCache.set(key, entry)
  return entry.value
}

function writeCachedCopilotContext(key: string, value: string): void {
  copilotContextCache.delete(key)
  if (copilotContextCache.size >= COPILOT_CONTEXT_MAX_ENTRIES) {
    const oldest = copilotContextCache.keys().next().value
    if (oldest !== undefined) copilotContextCache.delete(oldest)
  }
  copilotContextCache.set(key, { expiresAt: Date.now() + COPILOT_CONTEXT_TTL_MS, value })
}

/** Everything after the task: the voice, the product's facts and the platform's limit. */
function systemPrompt(
  access: OrganizationAccess,
  instructions: string,
  query: DocumentVoiceQuery
): Promise<string> {
  const prompt = (async () => {
    const voice = documentVoice(access, query)
    const product = productContext(access)
    const limit = query.channel
      ? `\n\nEach post is for ${query.channel} and may hold ${CAPABILITIES[query.channel].captionLimit} characters.`
      : ''
    return [instructions + limit + voiceInstructions(await voice), await product]
      .filter(Boolean)
      .join('\n\n')
  })()
  prompt.catch(() => undefined)
  return prompt
}

/** Cached voice/product system prompt for high-frequency inline copilot completions. */
function copilotSystemPrompt(
  access: OrganizationAccess,
  query: DocumentVoiceQuery
): Promise<string> {
  const key = copilotContextCacheKey(access, query)
  const cached = readCachedCopilotContext(key)
  if (cached !== null) return Promise.resolve(cached)
  const pending = copilotContextInFlight.get(key)
  if (pending) return pending
  const prompt = systemPrompt(access, DOCUMENT_COPILOT_INSTRUCTIONS, query)
    .then((resolved) => {
      writeCachedCopilotContext(key, resolved)
      return resolved
    })
    .finally(() => {
      if (copilotContextInFlight.get(key) === prompt) {
        copilotContextInFlight.delete(key)
      }
    })
  copilotContextInFlight.set(key, prompt)
  prompt.catch(() => undefined)
  return prompt
}

/** The document goes to the model as content, fenced, never as instructions. */
async function modelMessages(body: DocumentChatRequest) {
  const document = (body.system ?? '').replaceAll('</document_context>', '')
  const converted = trimMessagesToBudget(
    await convertToModelMessages(body.messages as unknown as UIMessage[])
  )
  return [
    { content: `<document_context>\n${document}\n</document_context>`, role: 'user' as const },
    ...converted,
  ]
}

/**
 * Streams the editor AI menu's answer. The stream opens with the tool the
 * editor asked for: `edit` replaces the selection, `generate` inserts blocks,
 * and `comment` sends one `data-comment` part per review comment. The credit
 * scope stays open until the model finishes, so the whole stream is charged.
 */
export function streamDocumentChat(
  access: OrganizationAccess,
  body: DocumentChatRequest,
  query: DocumentVoiceQuery
): Promise<Response> {
  const toolName = body.ctx?.toolName ?? 'generate'
  if (toolName === 'comment') return reviewDocument(access, body, query)
  const systemPromise = systemPrompt(access, DOCUMENT_EDITOR_INSTRUCTIONS, query)
  return new Promise<Response>((resolve, reject) => {
    withAiCredits(access, async () => {
      const [messages, system] = await Promise.all([modelMessages(body), systemPromise])
      const result = streamText({
        messages,
        model: models.languageModel('drafting'),
        system,
      })
      const stream = createUIMessageStream({
        execute: ({ writer }) => {
          writer.write({ data: toolName, type: 'data-toolName' })
          writer.merge(result.toUIMessageStream({ sendStart: false }))
        },
      })
      resolve(createUIMessageStreamResponse({ stream }))
      await result.consumeStream()
    }).catch(reject)
  })
}

async function reviewDocument(
  access: OrganizationAccess,
  body: DocumentChatRequest,
  query: DocumentVoiceQuery
): Promise<Response> {
  const systemPromise = systemPrompt(access, DOCUMENT_REVIEW_INSTRUCTIONS, query)
  const comments = await withAiCredits(access, async () => {
    const [messages, system] = await Promise.all([modelMessages(body), systemPromise])
    const { output } = await generateText({
      messages,
      model: models.languageModel('drafting'),
      output: Output.object({
        schema: z.object({ comments: z.array(documentReviewCommentSchema).max(5) }),
      }),
      system,
    })
    return output.comments
  })
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ data: 'comment', type: 'data-toolName' })
      for (const comment of comments) writer.write({ data: comment, type: 'data-comment' })
      writer.write({ data: comments.length, type: 'data-reviewed' })
    },
  })
  return createUIMessageStreamResponse({ stream })
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException('The request was aborted.', 'AbortError')
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    promise.catch(() => undefined)
    return Promise.reject(abortReason(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

/** One inline completion for the editor's copilot. */
export async function completeDocumentText(
  access: OrganizationAccess,
  body: z.infer<typeof documentCopilotRequestSchema>,
  query: DocumentVoiceQuery,
  options?: { abortSignal?: AbortSignal; model?: LanguageModel }
): Promise<{ text: string }> {
  const abortSignal = options?.abortSignal
  if (abortSignal?.aborted) throw abortReason(abortSignal)
  const systemPromise = copilotSystemPrompt(access, query)
  return withAiCredits(access, async () => {
    const system = await raceWithAbort(systemPromise, abortSignal)
    if (abortSignal?.aborted) throw abortReason(abortSignal)
    const { text } = await generateText({
      abortSignal,
      maxOutputTokens: COPILOT_MAX_OUTPUT_TOKENS,
      model: options?.model ?? models.languageModel('fast'),
      prompt: body.prompt,
      system,
    })
    return { text: text.trim() || '0' }
  })
}

/** Enforces copilot feature gates, per-user-before-workspace rate limits, and abort-to-499 handling. */
export async function handleDocumentCopilotRequest(
  input: {
    access: OrganizationAccess
    body: z.infer<typeof documentCopilotRequestSchema>
    query: DocumentVoiceQuery
    signal: AbortSignal
  },
  deps: {
    checkRateLimit: (identifier: string, policy: RateLimitPolicy) => Promise<{ allowed: boolean }>
    complete?: typeof completeDocumentText
    isAiEnabled: (access: OrganizationAccess) => Promise<boolean>
    isConfigured: () => boolean
  }
): Promise<Response | { text: string }> {
  const { access, body, query, signal } = input
  if (signal.aborted) return new Response(null, { status: 499 })
  if (!deps.isConfigured()) return errorResponse(503, 'AI is not configured.')
  const [enabled, userLimit] = await Promise.all([
    deps.isAiEnabled(access),
    deps.checkRateLimit(
      `editor-copilot-user:${access.organizationId}:${access.principal.userId}`,
      EDITOR_COPILOT_USER_RATE_LIMIT
    ),
  ])
  if (!enabled) {
    return errorResponse(403, 'AI is turned off for this workspace.')
  }
  if (!userLimit.allowed) {
    return errorResponse(429, 'Too many AI requests. Wait a minute and try again.')
  }
  if (signal.aborted) return new Response(null, { status: 499 })
  const workspaceLimit = await deps.checkRateLimit(
    `editor-copilot:${access.organizationId}`,
    EDITOR_COPILOT_RATE_LIMIT
  )
  if (!workspaceLimit.allowed) {
    return errorResponse(429, 'Too many AI requests. Wait a minute and try again.')
  }
  try {
    return await (deps.complete ?? completeDocumentText)(access, body, query, {
      abortSignal: signal,
    })
  } catch (error) {
    if (signal.aborted) return new Response(null, { status: 499 })
    throw error
  }
}
