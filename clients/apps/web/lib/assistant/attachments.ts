import { z } from 'zod'

/** Images one message to the assistant may carry. */
export const ATTACHMENTS_MAX = 3
/** Base64 characters of one attached image or snapshot. */
export const ATTACHMENT_DATA_MAX = 1_500_000

/** File bytes sent inline. An address is refused: the server must never fetch one for a caller. */
const inlineFileSchema = z.looseObject({
  type: z.literal('file'),
  data: z.strictObject({
    type: z.literal('data'),
    data: z
      .string()
      .max(ATTACHMENT_DATA_MAX)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  }),
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
})

/** Whether every file anywhere in the messages is an inline image. */
export function onlyInlineFiles(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(onlyInlineFiles)
  if (!value || typeof value !== 'object') return true
  const type = (value as { type?: unknown }).type
  if (typeof type === 'string' && /(^|-)(file|image)(-|$)/.test(type))
    return inlineFileSchema.safeParse(value).success
  // A tool call's own input is data the model wrote, never fetched. Only that key is skipped:
  // anything else claiming to be a tool call is checked like the rest.
  return Object.entries(value).every(
    ([key, item]) => (type === 'tool-call' && key === 'input') || onlyInlineFiles(item)
  )
}

/** The content of a message: its words, then any attached images. */
export function userContent(ask: string, images: readonly string[] = []) {
  if (images.length === 0) return ask
  return [
    { text: ask, type: 'text' },
    ...images.slice(0, ATTACHMENTS_MAX).map((data) => ({
      data: { data, type: 'data' },
      mediaType: 'image/jpeg',
      type: 'file',
    })),
  ]
}
