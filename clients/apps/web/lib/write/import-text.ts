import { platformCaptionLength } from '@/lib/content-drafts/serialize'
import type { DraftChannel, PlateBody } from './document'
import { postBreak } from './versions'

/** The posts one thread can hold, wherever a thread is built or appended to. */
export const THREAD_POST_LIMIT = 25

/** Import only explicit thread delimiters; URL query values are already decoded by Next. */
export function importedPosts(text: string): string[] {
  if (text.length > 100_000) throw new Error('Import at most 100,000 characters.')
  const posts = text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*---[ \t]*\n|\n(?:[ \t]*\n){3,}/)
    .map((post) => post.trim())
    .filter(Boolean)
  if (posts.length > THREAD_POST_LIMIT)
    throw new Error(`A thread can contain at most ${THREAD_POST_LIMIT} posts.`)
  return posts
}

/** Build normal Plate blocks, never HTML; imported markup cannot become executable content. */
export function importedBody(posts: string[]): PlateBody {
  return posts.flatMap((post) => [
    postBreak(),
    ...post.split('\n').map((text) => ({ type: 'p', children: [{ text }] })),
  ])
}

/** Split on word boundaries, preserving URLs and whole graphemes, with no model call. */
export function splitThread(text: string, channel: DraftChannel, limit: number): string[] {
  if (!Number.isInteger(limit) || limit < 23 || limit > 25_000)
    throw new Error('Choose a post length between 23 and 25,000.')
  if (text.length > 100_000) throw new Error('Import at most 100,000 characters.')
  // Only X's and Mastodon's counts (a short link is 23) exceed UTF-16 units: elsewhere, a text within the limit in units fits.
  const fits = (value: string) =>
    (channel !== 'x' && channel !== 'mastodon' && value.length <= limit) ||
    platformCaptionLength(channel, value) <= limit
  const posts: string[] = []
  let current = ''
  const push = () => {
    if (current.trim()) posts.push(current.trim())
    current = ''
    if (posts.length > THREAD_POST_LIMIT)
      throw new Error(
        `This text needs more than ${THREAD_POST_LIMIT} posts. Shorten it or increase the limit.`
      )
  }
  for (const token of text.replace(/\r\n?/g, '\n').match(/\S+\s*/g) ?? []) {
    if (fits((current + token).trim())) {
      current += token
      continue
    }
    push()
    if (fits(token.trim())) {
      current = token
      continue
    }
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
      token
    )) {
      if (!fits(segment))
        throw new Error('A character sequence exceeds the selected limit.')
      if (!fits((current + segment).trim())) push()
      current += segment
    }
  }
  push()
  return posts
}
