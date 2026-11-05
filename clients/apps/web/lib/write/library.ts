import type { DraftWire } from '@/lib/content-drafts/client'
import { draftPlainText } from '@/lib/content-drafts/serialize'
import { startOfWeek } from '@/lib/plan/calendar'
import { addDays, zonedInstant } from '@/lib/settings/zoned-time'

/**
 * The library's URL query as last asked for. Each change merges into the
 * newest intended query rather than the address bar, which still shows the
 * old query while a router navigation is in flight. A search or a lifecycle
 * tab alone skips the server (the browser loads that list itself), but not
 * while a navigation is pending: replacing history then would discard it and
 * keep a filter the person just removed. `settle` once the router commits a URL.
 */
export function libraryQuery(location: () => string) {
  let pending: string | null = null
  return {
    change(next: Record<string, string | undefined>) {
      const query = new URLSearchParams(pending ?? location())
      for (const [key, value] of Object.entries(next)) {
        if (value) query.set(key, value)
        else query.delete(key)
      }
      const navigate =
        pending !== null || Object.keys(next).some((key) => key !== 'q' && key !== 'tab')
      if (navigate) pending = query.toString()
      return { navigate, search: query.toString() }
    },
    settle() {
      pending = null
    },
  }
}

/** The saved fields a draft contributes to the Write library. */
export function libraryDraft(draft: DraftWire) {
  const text = draft.plainText || draftPlainText(draft.body)
  return {
    attentionPosts: draft.attentionPosts,
    channelConnectionIds: draft.channelConnectionIds,
    checkPosts: draft.checkPosts,
    excerpt: text.slice(0, 180),
    id: draft.id,
    searchText: `${text} ${draft.scratchpad}`,
    kind: draft.kind,
    nextPostAt: draft.nextPostAt,
    publishingPosts: draft.publishingPosts,
    pinned: draft.pinnedAt !== null,
    plannedFor: draft.plannedFor,
    publishedPosts: draft.publishedPosts,
    queuedPosts: draft.queuedPosts,
    reviewStatus: draft.reviewStatus,
    shared: draft.shareToken !== null,
    status: draft.status,
    tagIds: draft.tagIds,
    title: draft.title,
    updatedAt: draft.updatedAt,
  }
}

/** Inclusive days in a brand's zone as the instants the API filters by: `to` is exclusive. */
export function libraryRange(
  days: { from?: string; to?: string },
  zone: string
): { from?: string; to?: string } {
  return {
    ...(days.from ? { from: zonedInstant(days.from, 0, 0, zone).toISOString() } : {}),
    ...(days.to ? { to: zonedInstant(addDays(days.to, 1), 0, 0, zone).toISOString() } : {}),
  }
}

/** The days a date preset covers, from today in the brand's zone. */
export function datePreset(
  preset: 'today' | 'week' | 'month',
  today: string,
  weekStart: number
): { from: string; to: string } {
  if (preset === 'today') return { from: today, to: today }
  if (preset === 'week') {
    const from = startOfWeek(today, weekStart)
    return { from, to: addDays(from, 6) }
  }
  const [year, month] = today.split('-').map(Number)
  const last = new Date(Date.UTC(year!, month!, 0)).getUTCDate()
  return { from: `${today.slice(0, 7)}-01`, to: `${today.slice(0, 7)}-${last}` }
}

/** The queue rows matching the account and instants, which are ISO strings in UTC. */
export function filterQueue<T extends { accountIds: string[]; at: string }>(
  rows: T[],
  account: string | undefined,
  range: { from?: string; to?: string }
): T[] {
  return rows.filter(
    (row) =>
      (!account || row.accountIds.includes(account)) &&
      (!range.from || row.at >= range.from) &&
      (!range.to || row.at < range.to)
  )
}
