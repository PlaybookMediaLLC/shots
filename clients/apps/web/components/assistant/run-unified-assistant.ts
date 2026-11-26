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
  executeClientTool,
  images,
  memory,
  page,
  push,
  selection = null,
  signal,
  stream,
}: AbilityRun & {
  clientTools?: readonly string[]
  executeClientTool?: ClientToolExecutor
}): Promise<void> {
  const base = recentMessages(memory.current, MAX_ASSISTANT_MESSAGES - 1)
  let current: unknown[] = [...base, { content: userContent(ask, images), role: 'user' }]
  const seenActivity = new Set<string>()

  try {
    for (let trip = 0; trip < MAX_ROUND_TRIPS; trip += 1) {
      signal?.throwIfAborted()
      const response = await fetch('/api/ai/assistant', {
        body: JSON.stringify({
          ...(clientTools.length > 0 ? { clientTools } : {}),
          // Every round trip adds messages, so each request is trimmed to the contract limit.
          messages: recentMessages(current, MAX_ASSISTANT_MESSAGES),
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
      const reply = await readReply(response, (line) => {
        if (line.type === 'text') {
          text += line.text
          stream?.(text)
        } else if (!seenActivity.has(line.name) && !SILENT_TOOLS.has(line.name)) {
          seenActivity.add(line.name)
          push({ kind: 'activity', text: describeToolActivity(line.name) })
        }
      }).finally(() => stream?.(''))
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
        results.push({
          output,
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          type: 'tool-result',
        })
      }
      current = trimSnapshots([...current, { content: results, role: 'tool' }])
      memory.current = current
    }
  } catch (error) {
    // An aborted turn may have changed the surface part way; start clean next turn.
    if (signal?.aborted) memory.current = []
    throw error
  }
}
