import type { DraftChannel } from './document'

/**
 * How a platform counts a caption, in one sentence. A number on its own does
 * not explain why a 280-character post reads as 290, and the rules differ: X
 * weighs every link at 23 and most non-Latin characters at two, while the
 * others count what is written. Every counter in the composer says this the
 * same way.
 */
export function countingNote(channel: DraftChannel): string {
  return channel === 'x'
    ? 'Counted as X counts it: a line break is one character, any link is 23, and an emoji or a non-Latin character is two.'
    : 'Counted as the platform counts it, including line breaks.'
}
