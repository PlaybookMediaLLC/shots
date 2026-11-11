/**
 * Reading a pasted block as a run of posts. Writers draft a week of posts in
 * a notes app with a blank line between each one, so the paste that lands in
 * the new-draft box is already separated; the only question is whether those
 * pieces are one post, one thread, or several posts.
 *
 * This decides nothing. It reports the pieces and what each costs on a
 * platform; the writer chooses.
 */

import { platformCaptionLength } from '@/lib/content-drafts/serialize'
import { CAPABILITIES } from './capabilities'
import type { DraftChannel } from './document'

/** The most posts one paste may become, matching the thread limit. */
export const PASTE_PIECE_LIMIT = 25

/** A line of three or more dashes: a separator the writer typed on purpose. */
const RULE = /\n[ \t]*-{3,}[ \t]*(?=\n|$)/

/**
 * The pieces of a pasted block: text separated by a blank line, or by a line
 * of three or more dashes. Leading and trailing blank space goes, and an
 * empty piece is not a post.
 */
export function pastePieces(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    // A rule between ideas separates them as firmly as a blank line does.
    .replace(new RegExp(RULE.source, 'g'), '\n')
    .split(/\n[ \t]*\n+/)
    .map((piece) => piece.trim())
    .filter(Boolean)
}

/**
 * A paste read for the batch page. Lines of dashes are explicit separators:
 * when there are any, only they split, so a post keeps its own paragraphs.
 * Without them the pieces are the blank-line ones, offered as a choice; the
 * caller keeps the paste as one post unless the writer chooses otherwise.
 */
export function readPaste(text: string): { explicit: boolean; pieces: string[] } {
  const normalized = `\n${text.replace(/\r\n?/g, '\n')}`
  if (!RULE.test(normalized)) return { explicit: false, pieces: pastePieces(text) }
  return {
    explicit: true,
    // A run of blank lines inside a post is one paragraph break: three would make it a thread.
    pieces: normalized
      .split(new RegExp(RULE.source, 'g'))
      .map((piece) => piece.replace(/\n(?:[ \t]*\n){2,}/g, '\n\n').trim())
      .filter(Boolean),
  }
}

/**
 * The platform a pasted run is measured against: X when the brand posts
 * there, because its limit is the tightest a writer meets, otherwise the
 * brand's first account.
 */
export function countingChannelFor(
  accounts: readonly { channel: DraftChannel }[] | undefined
): DraftChannel {
  if (accounts?.some((account) => account.channel === 'x')) return 'x'
  return accounts?.[0]?.channel ?? 'x'
}

/** One piece of a paste, with what it costs on the platform it is measured for. */
export type MeasuredPiece = {
  /** Characters, counted as the platform counts them. */
  length: number
  /** Past the platform's standard limit, so it cannot go out as one post. */
  over: boolean
  text: string
}

/**
 * Each piece with its length on a platform, against that platform's standard
 * limit rather than an account's raised one: a post over 280 on X reads as
 * truncated to everyone without the raised limit.
 */
export function measurePieces(pieces: readonly string[], channel: DraftChannel): MeasuredPiece[] {
  const limit = CAPABILITIES[channel].captionLimit
  return pieces.map((text) => {
    const length = platformCaptionLength(channel, text)
    return { length, over: length > limit, text }
  })
}
