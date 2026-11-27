/**
 * Canvas snapshot hygiene, shared by the browser (what it sends) and the
 * server (what the model reads): only the newest snapshot is worth its tokens.
 */

type Part = { type?: unknown; output?: { type?: unknown; value?: unknown } }

/** Replace every canvas snapshot but the newest with a short note. */
export function trimSnapshots<T>(messages: readonly T[]): T[] {
  let latestFound = false
  const trim = (part: Part) => {
    if (part.type !== 'tool-result' || part.output?.type !== 'content') return part
    const value = part.output.value as { type?: string }[]
    if (!value.some((item) => item.type === 'file')) return part
    if (!latestFound) {
      latestFound = true
      return part
    }
    return {
      ...part,
      output: {
        type: 'content',
        value: value.map((item) =>
          item.type === 'file' ? { text: '[earlier snapshot omitted]', type: 'text' } : item
        ),
      },
    }
  }
  // Newest first, through the messages and through the results within one message.
  const result = [...messages]
  // Attached images go with the newest ask only; they are not billed on every later turn.
  let newestAsk = true
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const message = result[index] as { role?: string; content?: unknown }
    if (message.role !== 'user') continue
    if (!newestAsk && Array.isArray(message.content))
      result[index] = {
        ...message,
        content: (message.content as Part[]).map((part) =>
          part.type === 'file' ? { text: '[earlier image omitted]', type: 'text' } : part
        ),
      } as T
    newestAsk = false
  }
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const message = result[index] as { role?: string; content?: unknown }
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue
    const content = [...(message.content as Part[])].reverse().map(trim).reverse()
    result[index] = { ...message, content } as T
  }
  return result
}

/** Default character budget (~40k tokens) for sliding-window model message history. */
export const DEFAULT_MESSAGE_BUDGET_CHARS = 160_000

export type MeasureMessageCharsOptions = {
  /** Exempt `file` parts' inline `{ type: 'data', data: string }` base64 payload (still counts sibling keys). */
  allowInlineFileData?: boolean
  /** Fixed character weight charged for each exempted inline file payload. Defaults to 0. */
  fileWeight?: number
  /** Stop traversing early once total strictly exceeds this limit. */
  limit?: number
}

function isInlineFileData(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.type === 'data' && typeof record.data === 'string'
}

function pushObjectChildren(
  record: Record<string, unknown>,
  allowInlineFileData: boolean,
  stack: unknown[]
): boolean {
  const exemptData = allowInlineFileData && record.type === 'file' && isInlineFileData(record.data)
  for (const [key, child] of Object.entries(record)) {
    if (exemptData && key === 'data') continue
    stack.push(child)
  }
  return exemptData
}

/**
 * Iteratively sum string character lengths across a message payload with optional
 * early exit and inline-file payload exemption (never exempting raw `data:image/`
 * text strings or sibling loose keys).
 */
export function measureMessageChars(
  value: unknown,
  options: MeasureMessageCharsOptions = {}
): number {
  const { allowInlineFileData = false, fileWeight = 0, limit = Number.POSITIVE_INFINITY } = options
  let total = 0
  const stack: unknown[] = [value]
  while (stack.length > 0 && total <= limit) {
    const node = stack.pop()
    if (typeof node === 'string') {
      total += node.length
      continue
    }
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item)
      continue
    }
    if (node && typeof node === 'object') {
      if (pushObjectChildren(node as Record<string, unknown>, allowInlineFileData, stack)) {
        total += fileWeight
      }
    }
  }
  return total
}

/**
 * Keep the newest user turns within a character budget so long conversations
 * never blow past model context windows or re-bill unbounded history. Always
 * preserves the latest user turn (including any trailing tool continuations)
 * and only drops whole older turns starting at `role === 'user'` boundaries so
 * assistant tool-call / tool-result pairs are never split.
 */
export function trimMessagesToBudget<T extends { role?: string }>(
  messages: readonly T[],
  maxChars: number = DEFAULT_MESSAGE_BUDGET_CHARS
): T[] {
  if (messages.length <= 1) return [...messages]
  // Group messages into turns anchored on each user message.
  const turnStarts: number[] = []
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === 'user' || turnStarts.length === 0) {
      turnStarts.push(i)
    }
  }
  const turnSizes = turnStarts.map((start, idx) => {
    const end = idx + 1 < turnStarts.length ? turnStarts[idx + 1]! : messages.length
    let sum = 0
    for (let i = start; i < end; i += 1) {
      sum += measureMessageChars(messages[i], { allowInlineFileData: true, fileWeight: 2_000 })
    }
    return sum
  })
  // Always keep the newest turn; walk backwards adding older turns that fit.
  let used = turnSizes.at(-1) ?? 0
  let keepFromTurn = turnStarts.length - 1
  for (let t = turnStarts.length - 2; t >= 0; t -= 1) {
    if (used + turnSizes[t]! > maxChars) break
    used += turnSizes[t]!
    keepFromTurn = t
  }
  const startIndex = turnStarts[keepFromTurn] ?? 0
  return startIndex === 0 ? [...messages] : messages.slice(startIndex)
}
