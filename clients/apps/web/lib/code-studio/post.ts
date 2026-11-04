import { xLength } from '@/lib/content-drafts/x-length'
import { draftAssetNode } from '@/lib/platform/asset-handoff'
import type { PlateBody } from '@/lib/write/document'
import { postBreak } from '@/lib/write/versions'
import { languageLabel } from './languages'

/** Alt text the asset may hold; the backend refuses longer. */
export const ALT_TEXT_LIMIT = 1_000
/** A standard X account's post length; longer replies need X Premium. */
export const X_POST_LIMIT = 280

/**
 * Alt text for a code image: the language, then the code, cut at the limit
 * without splitting a character, so screen readers get what the image shows.
 */
export function codeAltText(code: string, lang: string): string {
  const text = `${languageLabel(lang)} code:\n${code.trim()}`
  const characters = [...text]
  if (characters.length <= ALT_TEXT_LIMIT) return text
  return `${characters.slice(0, ALT_TEXT_LIMIT - 1).join('')}…`
}

/** The code as a reply post: a code block, one line per code line. */
function codeReply(code: string, lang: string): PlateBody {
  return [
    postBreak(),
    {
      type: 'code_block',
      lang,
      children: code.split('\n').map((text) => ({ type: 'code_line', children: [{ text }] })),
    },
  ]
}

/** One post per media item, a carousel of images, or a document, plus an optional code reply. */
export type CodePostMedia = { id: string; mediaType: string; alt: string }

/**
 * A draft body for "Post this": the first post holds the media with its alt
 * text, and the code optionally follows as a reply in the thread.
 */
export function codePostBody(input: {
  media: CodePostMedia[]
  caption?: string
  reply?: { code: string; lang: string }
}): PlateBody {
  return [
    postBreak(),
    { type: 'p', children: [{ text: input.caption ?? '' }] },
    ...input.media.map((media) => ({ ...draftAssetNode(media), alt: media.alt })),
    ...(input.reply ? codeReply(input.reply.code, input.reply.lang) : []),
  ]
}

/** Whether a code reply fits one post on a standard X account. */
export function replyFitsX(code: string): boolean {
  return xLength(code) <= X_POST_LIMIT
}
