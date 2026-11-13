import type { DraftActivityWire } from '@/lib/write/client'

/** The longest gap between two changes by one author that still groups them. */
export const HISTORY_GROUP_GAP_MS = 30 * 60 * 1000

/** Consecutive changes by one author, newest first. */
export type HistoryGroup = { id: string; items: DraftActivityWire[] }

/** Who made a change: the person, or the key, workflow or service when no person did. */
function author(item: DraftActivityWire): string {
  return item.actorUserId ? `person:${item.actorUserId}` : `source:${item.source}`
}

/**
 * Groups a history read newest first: a change joins the group above it when
 * the same author made it within {@link HISTORY_GROUP_GAP_MS} of that group's
 * oldest change. The same events always make the same groups.
 */
export function groupHistory(items: DraftActivityWire[]): HistoryGroup[] {
  const groups: HistoryGroup[] = []
  for (const item of items) {
    const group = groups.at(-1)
    const oldest = group?.items.at(-1)
    if (
      group &&
      oldest &&
      author(oldest) === author(item) &&
      new Date(oldest.at).getTime() - new Date(item.at).getTime() <= HISTORY_GROUP_GAP_MS
    )
      group.items.push(item)
    else groups.push({ id: item.id, items: [item] })
  }
  return groups
}
