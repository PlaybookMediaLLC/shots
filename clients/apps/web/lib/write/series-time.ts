/**
 * Where the composer opens its day and time. Writing a run of posts in one
 * sitting, the useful default is "a gap after the one I just scheduled", not
 * a fixed hour tomorrow: the writer who queued 4:00 PM today means 5:00 PM
 * today next, not 9:00 AM tomorrow.
 */

/** How far ahead a queued post still counts as "the one I am writing after". */
export const SERIES_WINDOW_MS = 24 * 3_600_000

/**
 * The time to open on, or null when nothing suggests one and the caller
 * should keep its own default.
 *
 * In order: a gap after the latest post already queued within the next day,
 * then the brand's next free recurring slot. A remembered time from this
 * session counts as queued, so the suggestion is right even before the queue
 * has been read again.
 */
export function nextSeriesTime(options: {
  /** Minutes to leave after the last post of a run. */
  gapMinutes: number
  now: Date
  /** Instants already committed, in any order, as ISO 8601 strings. */
  queued: readonly string[]
  /** The brand's free recurring slots, in any order. */
  slots: readonly Date[]
}): Date | null {
  const { gapMinutes, now, queued, slots } = options
  const horizon = now.getTime() + SERIES_WINDOW_MS
  const recent = queued
    .map((at) => new Date(at).getTime())
    .filter((time) => Number.isFinite(time) && time > now.getTime() && time <= horizon)
  if (recent.length) {
    const after = new Date(Math.max(...recent) + gapMinutes * 60_000)
    // A gap that lands in the past cannot be a default; fall through to the slots.
    if (after.getTime() > now.getTime()) return after
  }
  const free = slots
    .map((slot) => slot.getTime())
    .filter((time) => Number.isFinite(time) && time > now.getTime())
  return free.length ? new Date(Math.min(...free)) : null
}
