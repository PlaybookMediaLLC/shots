/**
 * Posts written and scheduled as one run. A draft has no series of its own in
 * the data model, so a run is held together by the title its drafts share:
 * "Storytelling · 3/7". That keeps each draft nameable on its own in the
 * library while the queue can still gather the run and move or cancel it as
 * a unit.
 *
 * Everything that writes or reads that convention lives here, so a first
 * class series on the backend later has one place to replace.
 */

/** The separator between a series name and a post's place in it. */
const MARK = ' · '

/** How long a series name may be, leaving room for the mark inside a title. */
export const SERIES_NAME_LIMIT = 120

/** A series name from the run's first words, so a paste needs no naming step. */
export function suggestedSeriesName(firstPiece: string, fallback = 'Series'): string {
  const line = firstPiece
    .split('\n')
    .map((text) => text.trim())
    .find(Boolean)
  if (!line) return fallback
  const words = line.slice(0, 48).split(/\s+/)
  // Never end on half a word unless the first word is already too long.
  const trimmed = words.length > 1 && line.length > 48 ? words.slice(0, -1).join(' ') : words.join(' ')
  return trimmed.replace(/[\s·]+$/, '') || fallback
}

/** The title the nth post of a run carries. */
export function seriesTitle(name: string, index: number, total: number): string {
  return `${name.slice(0, SERIES_NAME_LIMIT).trim()}${MARK}${index + 1}/${total}`
}

/** The series a title belongs to, or null when the title names no run. */
export function seriesName(title: string | null | undefined): string | null {
  if (!title) return null
  const match = /^(.+)· \d+\/\d+$/.exec(title.trim())
  const name = match?.[1].trim()
  return name ? name : null
}
