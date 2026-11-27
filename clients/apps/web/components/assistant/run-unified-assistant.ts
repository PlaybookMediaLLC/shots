'use client'

import type { ToolResultPart } from 'ai'
import {
  type AssistantPendingToolCall,
  type AssistantProgress,
  assistantStreamLineSchema,
  MAX_ASSISTANT_MESSAGES,
} from '@/lib/api/contracts/ai'
import type { AbilityRun, AssistantEntry } from '@/lib/assistant/ability'
import { internalHref } from '@/lib/assistant/page-context'
import { userContent } from '@/lib/assistant/attachments'
import { trimSnapshots } from '@/lib/assistant/snapshots'

const MAX_ROUND_TRIPS = 16

/** Human-friendly status labels for tools executed during an assistant turn. */
export const TOOL_ACTIVITY_LABELS: Record<string, string> = {
  applySavedPreset: 'Applying saved preset',
  editBoard: 'Updating the board',
  editCodeScene: 'Updating the code scene',
  editStorySet: 'Updating the Story Set',
  editTweet: 'Restyling the card',
  getReleaseDetails: 'Reading the release',
  getSocialAnalyticsSummary: 'Reading post metrics',
  inspectBoard: 'Reading the board',
  inspectCodeScene: 'Reading the code scene',
  inspectDraft: 'Reading the draft',
  inspectStorySet: 'Reading the Story Set',
  inspectTweet: 'Reading the card',
  preparePost: 'Preparing a post',
  proposeCaptureRecipe: 'Drafting a capture recipe',
  proposeDraftText: 'Writing a suggestion',
  applyBrandKit: 'Applying brand kit',
  applyChanges: 'Updating design',
  captureIntoCanvas: 'Capturing URL into canvas',
  dispatchStoreCommands: 'Updating App Store slides',
  draftPost: 'Drafting social post',
  findPages: 'Finding app pages',
  generateAiBackground: 'Generating AI background',
  generateStoreCopy: 'Writing store copy',
  getBrand: 'Checking brand profile',
  getIdealCustomerProfile: 'Checking ideal customer profile',
  getProduct: 'Checking product context',
  insertWorkspaceAsset: 'Inserting library asset',
  inspectCanvas: 'Inspecting canvas',
  inspectStoreSet: 'Inspecting App Store set',
  inspectWorkspaceSetup: 'Checking workspace setup',
  listBrandKits: 'Checking brand kits',
  listCampaigns: 'Checking campaigns',
  listProductSurfaces: 'Checking product surfaces',
  listRecentWork: 'Checking recent work',
  listScheduledPosts: 'Checking scheduled posts',
  listDesignOptions: 'Checking design catalog',
  offerLink: 'Preparing navigation link',
  reviewDesign: 'Reviewing design',
  scanRedactions: 'Scanning for sensitive info',
  searchWorkspaceAssets: 'Searching workspace assets',
  showCaptions: 'Preparing social captions',
  showVariants: 'Preparing visual variants',
  startWork: 'Preparing starter action',
  translateStoreLocales: 'Translating store locales',
  undoLastChange: 'Undoing last change',
}

/** Format a tool name into a readable short label. */
export function describeToolActivity(toolName: string): string {
  return TOOL_ACTIVITY_LABELS[toolName] ?? toolName
}

/**
 * The newest `room` messages, starting at one of the person's, so a tool call
 * is never sent without the result that answered it.
 */
export function recentMessages(messages: readonly unknown[], room: number): unknown[] {
  let start = Math.max(0, messages.length - room)
  while (start < messages.length && (messages[start] as { role?: string }).role !== 'user')
    start += 1
  return messages.slice(start)
}

/** Server tools whose result is its own entry, so they need no activity line. */
const SILENT_TOOLS = new Set(['offerLink', 'startWork'])

/** Read the reply stream: progress to `onProgress`, then the finished reply. */
async function readReply(response: Response, onProgress: (line: AssistantProgress) => void) {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    buffer += value ?? ''
    const lines = buffer.split('\n')
    // The text after the last newline is not a whole line yet.
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      if (!raw) continue
      const line = assistantStreamLineSchema.parse(JSON.parse(raw))
      if (line.type === 'reply') return line.reply
      if (line.type === 'error') throw new Error(line.error)
      onProgress(line)
    }
    if (done) throw new Error('The assistant stopped before it finished. Try again.')
  }
}

export type ClientToolExecutor = (
  call: AssistantPendingToolCall,
  context: {
    push: (entry: AssistantEntry) => void
    signal?: AbortSignal
  }
) => Promise<ToolResultPart['output']>

/**
 * Unified client-server hybrid turn loop against `POST /api/ai/assistant`.
 *
 * Works identically for read-only workspace pages (`clientTools: []`) and rich
 * editing surfaces (`clientTools: [...]` + `executeClientTool`), allowing one
 * conversation to seamlessly combine workspace lookups and direct surface edits.
 */
export async function runUnifiedAssistant({
  ask,
  clientTools = [],
  contextRefs = [],
  effort,
  executeClientTool,
  images,
  memory,
  modelTier,
  page,
  push,
  selection = null,
  signal,
  status,
  stream,
  updateActivity,
}: AbilityRun & {
  clientTools?: readonly string[]
  executeClientTool?: ClientToolExecutor
}): Promise<void> {
  // Snapshot prior clean conversation so stopping mid-turn never wipes earlier turns.
  const previousMemory = [...memory.current]
  const base = recentMessages(memory.current, MAX_ASSISTANT_MESSAGES - 1)
  let current: unknown[] = [...base, { content: userContent(ask, images), role: 'user' }]
  const activityIds = new Map<string, number>()
  const runningActivityIds = new Set<number>()

  const markActivity = (toolName: string, next: 'running' | 'done' | 'error') => {
    const id = activityIds.get(toolName)
    if (id !== undefined) {
      updateActivity?.(id, next)
      if (next === 'running') runningActivityIds.add(id)
      else runningActivityIds.delete(id)
    } else if (!SILENT_TOOLS.has(toolName)) {
      const created = push({
        done: next === 'done',
        kind: 'activity',
        status: next,
        text: describeToolActivity(toolName),
      })
      if (typeof created === 'number') {
        activityIds.set(toolName, created)
        if (next === 'running') runningActivityIds.add(created)
      }
    }
  }

  try {
    for (let trip = 0; trip < MAX_ROUND_TRIPS; trip += 1) {
      signal?.throwIfAborted()
      const wireContextRefs = contextRefs.map(({ id, kind }) => ({ id, kind }))
      const response = await fetch('/api/ai/assistant', {
        body: JSON.stringify({
          ...(clientTools.length > 0 ? { clientTools } : {}),
          ...(wireContextRefs.length > 0 ? { contextRefs: wireContextRefs } : {}),
          ...(effort ? { effort } : {}),
          // Every round trip adds messages, so each request is trimmed to the contract limit.
          messages: recentMessages(current, MAX_ASSISTANT_MESSAGES),
          ...(modelTier ? { modelTier } : {}),
          page,
          ...(selection ? { selection } : {}),
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal,
      })
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null)
        const error =
          body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
            ? body.error
            : 'The assistant is unavailable.'
        throw new Error(error)
      }
      let text = ''
      let hasStatus = false
      let rafId: number | null = null
      const emitStream = (value: string) => {
        if (!stream) return
        if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
          stream(value)
          return
        }
        if (rafId !== null) return
        rafId = window.requestAnimationFrame(() => {
          rafId = null
          stream(text)
        })
      }
      const runningInStep: string[] = []
      const reply = await readReply(response, (line) => {
        if (line.type === 'text') {
          if (hasStatus) {
            hasStatus = false
            status?.('')
          }
          text += line.text
          emitStream(text)
        } else if (!SILENT_TOOLS.has(line.name)) {
          runningInStep.push(line.name)
          markActivity(line.name, 'running')
          hasStatus = true
          status?.(`${describeToolActivity(line.name)}…`)
        }
      }).finally(() => {
        if (rafId !== null && typeof window !== 'undefined') {
          window.cancelAnimationFrame(rafId)
          rafId = null
        }
        stream?.('')
        if (hasStatus) status?.('')
      })
      const pendingNames = new Set(reply.pendingToolCalls.map((call) => call.toolName))
      for (const name of runningInStep) {
        if (!pendingNames.has(name)) markActivity(name, 'done')
      }

      current = [...current, ...reply.messages]
      // A reply with calls still to answer is not saved: stopped here, it would block the thread.
      if (reply.pendingToolCalls.length === 0) memory.current = current

      if (reply.text) push({ kind: 'assistant', text: reply.text })
      for (const post of reply.posts) push({ kind: 'post', text: post.text })
      for (const link of reply.links) {
        const href = internalHref(link.href)
        if (href) push({ href, kind: 'link', text: link.label })
      }

      if (reply.done || reply.pendingToolCalls.length === 0) break

      const results: ToolResultPart[] = []
      for (const call of reply.pendingToolCalls) {
        signal?.throwIfAborted()
        markActivity(call.toolName, 'running')
        status?.(`${describeToolActivity(call.toolName)}…`)
        let output: ToolResultPart['output']
        try {
          output = executeClientTool
            ? await executeClientTool(call, { push, signal })
            : { type: 'error-text', value: `Tool ${call.toolName} is not supported on this page.` }
        } catch (error) {
          if (signal?.aborted) throw error
          // Every call needs a result, or the conversation cannot continue.
          output = {
            type: 'error-text',
            value: `${call.toolName} failed: ${error instanceof Error ? error.message : 'unknown'}`,
          }
        }
        markActivity(call.toolName, output.type === 'error-text' ? 'error' : 'done')
        results.push({
          output,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          type: 'tool-result',
        })
      }
      status?.('')
      current = trimSnapshots([...current, { content: results, role: 'tool' }])
      memory.current = current
    }
  } catch (error) {
    // Restore the last clean boundary before this aborted turn instead of wiping prior conversation memory.
    if (signal?.aborted) memory.current = previousMemory
    for (const id of runningActivityIds) {
      updateActivity?.(id, 'error')
    }
    runningActivityIds.clear()
    throw error
  } finally {
    status?.('')
  }
}
