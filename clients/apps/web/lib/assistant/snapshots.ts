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
