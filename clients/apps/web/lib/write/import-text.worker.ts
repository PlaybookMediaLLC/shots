import type { DraftChannel } from './document'
import { splitThread } from './import-text'

/** One split by post length, numbered so its answer can be matched to it. */
export type SplitRequest = { channel: DraftChannel; id: number; limit: number; text: string }

/** The posts for request `id`, or why its text cannot be split. */
export type SplitResult = { error: string; id: number; posts: string[] }

// Counting X's links is quadratic in a run without spaces (seconds for long
// CJK text), so the split runs here instead of on the page that is typing.
self.onmessage = ({ data }: MessageEvent<SplitRequest>) => {
  let result: SplitResult
  try {
    result = { error: '', id: data.id, posts: splitThread(data.text, data.channel, data.limit) }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'This text cannot be split.'
    result = { error: message, id: data.id, posts: [] }
  }
  self.postMessage(result)
}
