import { z } from 'zod'
import { INTERNAL_HREF_MAX, internalHref } from './page-context'

/**
 * What a saved thread keeps: the words and links. Cards, Undo and Accept act on
 * work that is open now, so they are not saved.
 */
export const savedEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.enum(['user', 'assistant', 'error', 'note', 'change', 'post']),
    // The database cannot store a NUL.
    text: z
      .string()
      .max(8_000)
      .transform((text) => text.replaceAll('\u0000', '')),
  }),
  z.object({
    kind: z.literal('link'),
    text: z.string().max(200),
    // Read back from storage, so it must still be a place inside the app.
    href: z.string().max(INTERNAL_HREF_MAX).refine((href) => internalHref(href) !== null),
  }),
])

/** One of {@link savedEntrySchema}. */
export type SavedEntry = z.infer<typeof savedEntrySchema>

/** Most entries one saved thread keeps, the newest. */
export const SAVED_ENTRIES_MAX = 100

/** Bytes of entries one saved thread keeps; the backend refuses more. */
const SAVED_BYTES_MAX = 190_000

/** The entries of a thread worth saving: the newest that fit. */
export function savedEntries(entries: readonly unknown[]): SavedEntry[] {
  const kept = entries
    .flatMap((entry) => {
      const parsed = savedEntrySchema.safeParse(entry)
      return parsed.success ? [parsed.data] : []
    })
    .slice(-SAVED_ENTRIES_MAX)
  const size = new TextEncoder()
  let bytes = 0
  let start = kept.length
  while (start > 0) {
    bytes += size.encode(JSON.stringify(kept[start - 1])).length + 1
    if (bytes > SAVED_BYTES_MAX) break
    start -= 1
  }
  return kept.slice(start)
}

/** The model's memory of a resumed thread: conversation turns plus concise summaries of prior edits/posts. */
export function resumedMemory(entries: readonly SavedEntry[]) {
  return entries.flatMap((entry) => {
    if (entry.kind === 'user' || entry.kind === 'assistant') {
      return [{ content: entry.text, role: entry.kind }]
    }
    if (entry.kind === 'change') {
      return [{ content: `[Applied earlier change: ${entry.text}]`, role: 'assistant' as const }]
    }
    if (entry.kind === 'post') {
      return [{ content: `[Drafted earlier post: ${entry.text}]`, role: 'assistant' as const }]
    }
    return []
  })
}
