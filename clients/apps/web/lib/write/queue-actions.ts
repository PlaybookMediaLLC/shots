/**
 * Editing a queue as a sequence rather than one post at a time: moving a run
 * later, spacing it evenly, gathering the posts written together, and saying
 * what looks wrong before it goes out.
 *
 * Everything here is a calculation over rows the queue already has. Nothing
 * here writes: the caller commits each new time through the post's own move
 * or swap, so the backend keeps deciding what a queued commitment may do.
 */

import { seriesName } from './series'

/** A queue row as the library holds it. */
export type QueueRow = {
  accountIds: string[]
  at: string
  caption: string
  draftId: string
  id: string
  kind: 'planned' | 'scheduled'
  title: string
}

/** Rows soonest first; ties keep the order they arrived in. */
function byTime<T extends { at: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.at.localeCompare(b.at))
}

/** Every selected row's new time after moving the whole selection by minutes. */
export function shiftedTimes(rows: readonly QueueRow[], minutes: number): Map<string, Date> {
  return new Map(
    rows.map((row) => [row.id, new Date(new Date(row.at).getTime() + minutes * 60_000)])
  )
}

/**
 * Selected rows spread evenly from `from` to `to`, keeping their order. One
 * row sits at `from`; a range that runs backwards is rejected by the caller,
 * not silently reversed here.
 */
export function evenTimes(rows: readonly QueueRow[], from: Date, to: Date): Map<string, Date> {
  const ordered = byTime(rows)
  if (ordered.length === 0) return new Map()
  const step =
    ordered.length === 1 ? 0 : (to.getTime() - from.getTime()) / (ordered.length - 1)
  return new Map(
    ordered.map((row, index) => [row.id, new Date(from.getTime() + Math.round(step * index))])
  )
}

/** The times a run would take, every `gapMinutes` from `from`, in the rows' order. */
export function spacedTimes(
  rows: readonly QueueRow[],
  from: Date,
  gapMinutes: number
): Map<string, Date> {
  return new Map(
    byTime(rows).map((row, index) => [
      row.id,
      new Date(from.getTime() + index * gapMinutes * 60_000),
    ])
  )
}

/** A run of posts written and scheduled together, or the ones that belong to none. */
export type QueueGroup = {
  /** The run's name, or null for posts that are not part of one. */
  name: string | null
  rows: QueueRow[]
}

/**
 * The runs the whole queue holds, by name: the drafts sharing a series name
 * ({@link seriesName}), where more than one of them is queued. A "run" of one
 * is just a post, and naming it would only add a row to read.
 *
 * This is read over the entire queue, not over the day being drawn, so a run
 * spread across two days is still one run on both of them.
 */
export function queueRuns(rows: readonly QueueRow[]): Map<string, QueueRow[]> {
  const byName = new Map<string, QueueRow[]>()
  for (const row of byTime(rows)) {
    const name = seriesName(row.title)
    if (name) byName.set(name, [...(byName.get(name) ?? []), row])
  }
  for (const [name, run] of byName) if (run.length < 2) byName.delete(name)
  return byName
}

/**
 * One stretch of the queue gathered into its runs, in time order, so the
 * queue still reads as a timeline. `runs` names what counts as a run, which
 * the caller takes from the whole queue.
 */
export function queueGroups(
  rows: readonly QueueRow[],
  runs: Map<string, QueueRow[]> = queueRuns(rows)
): QueueGroup[] {
  const groups: QueueGroup[] = []
  const byName = new Map<string, QueueGroup>()
  for (const row of byTime(rows)) {
    const name = seriesName(row.title)
    if (!name || !runs.has(name)) {
      groups.push({ name: null, rows: [row] })
      continue
    }
    const existing = byName.get(name)
    if (existing) {
      existing.rows.push(row)
      continue
    }
    const group: QueueGroup = { name, rows: [row] }
    byName.set(name, group)
    groups.push(group)
  }
  return groups
}

/** Something worth seeing before a queue goes out, and the rows it is about. */
export type QueueWarning = { ids: string[]; text: string }

/** A caption compared for repeats: spacing and case are not what makes two posts the same. */
function normalized(caption: string): string {
  return caption.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Repeats and crowding in what is queued: the same text queued more than
 * once, and two posts to one account closer together than `minutesApart`.
 * Both are mistakes a long queue hides and neither blocks anything.
 */
export function queueWarnings(
  rows: readonly QueueRow[],
  options: { minutesApart: number }
): QueueWarning[] {
  const warnings: QueueWarning[] = []
  const sameText = new Map<string, QueueRow[]>()
  for (const row of rows) {
    const key = normalized(row.caption)
    if (!key) continue
    sameText.set(key, [...(sameText.get(key) ?? []), row])
  }
  for (const repeated of sameText.values()) {
    // Posts of one draft to several accounts are the same text on purpose.
    const drafts = new Set(repeated.map((row) => row.draftId))
    if (repeated.length > 1 && drafts.size > 1)
      warnings.push({
        ids: repeated.map((row) => row.id),
        text: `The same text is queued ${repeated.length} times.`,
      })
  }
  const perAccount = new Map<string, QueueRow[]>()
  for (const row of byTime(rows))
    for (const account of row.accountIds)
      perAccount.set(account, [...(perAccount.get(account) ?? []), row])
  const crowded = new Set<string>()
  for (const queue of perAccount.values())
    for (let index = 1; index < queue.length; index += 1) {
      const gap = new Date(queue[index].at).getTime() - new Date(queue[index - 1].at).getTime()
      if (gap < options.minutesApart * 60_000) {
        crowded.add(queue[index - 1].id)
        crowded.add(queue[index].id)
      }
    }
  if (crowded.size)
    warnings.push({
      ids: [...crowded],
      text: `${crowded.size} posts go to one account less than ${options.minutesApart} minutes apart.`,
    })
  return warnings
}
