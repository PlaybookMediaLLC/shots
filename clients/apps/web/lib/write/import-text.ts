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
  const measure = (value: string) => platformCaptionLength(channel, value)
  const posts: string[] = []
  let current = ''
  // What `current` counts. A word is measured with the spaces before it, after a
  // letter: X's count trims a lone space, and a link right after U+FEFF is not
  // one. No count looks back further, so a post counts its words added up.
  let counted = 0
  const push = () => {
    if (current.trim()) posts.push(current.trim())
    current = ''
    counted = 0
    if (posts.length > THREAD_POST_LIMIT)
      throw new Error(
        `This text needs more than ${THREAD_POST_LIMIT} posts. Shorten it or increase the limit.`
      )
  }
  let gap = ''
  for (const token of text.replace(/\r\n?/g, '\n').match(/\S+\s*/g) ?? []) {
    const word = token.trimEnd()
    const space = token.slice(word.length)
    let count = current ? measure(`a${gap}${word}`) - 1 : measure(word)
    if (counted + count > limit) {
      push()
      count = measure(word)
    }
    // A word longer than a post is cut between graphemes, each time at the
    // longest piece that halving finds (a link can stop it short). A cut can
    // split a link, so pieces are measured whole.
    const ends =
      count > limit
        ? Array.from(
            new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(word),
            ({ index, segment }) => index + segment.length
          )
        : []
    let [start, first] = [0, 0]
    while (count > limit) {
      let [low, high] = [first - 1, ends.length - 2]
      while (low < high) {
        const middle = Math.ceil((low + high) / 2)
        if (measure(word.slice(start, ends[middle])) <= limit) low = middle
        else high = middle - 1
      }
      if (low < first) throw new Error('A character sequence exceeds the selected limit.')
      current = word.slice(start, ends[low])
      push()
      ;[start, first] = [ends[low], low + 1]
      count = measure(word.slice(start))
    }
    current += word.slice(start) + space
    counted += count
    gap = space
  }
  push()
  return posts
}
