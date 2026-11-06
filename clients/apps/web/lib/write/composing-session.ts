/**
 * What one writing session carries from the post just scheduled to the next
 * one: the accounts it went to, when it goes out, the gap the writer put
 * between posts, and which "switched off" notices they have already read.
 *
 * It lives in `sessionStorage`, per brand, so a series written in one sitting
 * keeps its shape while a new tab or a new day starts from the brand's own
 * defaults. Nothing here decides what publishes: every value is a starting
 * point the composer shows, and the writer can change before confirming.
 */

/** The smallest and largest gap worth learning from one schedule to the next. */
const GAP_RANGE = { max: 24 * 60, min: 5 } as const

/** The gap a series falls back to when the session has not learned one. */
export const DEFAULT_SERIES_GAP_MINUTES = 60

/** What the session remembers about writing for one brand. */
export type ComposingMemory = {
  /** The accounts the last scheduled post published to. */
  channelIds: string[]
  /** Minutes between the two most recently scheduled posts. */
  gapMinutes: number
  /** The instant last scheduled from this brand, as an ISO 8601 string. */
  lastScheduledAt: string | null
  /** Accounts whose "switched off, no media yet" notice has been shown. */
  noticedOff: string[]
}

const EMPTY: ComposingMemory = {
  channelIds: [],
  gapMinutes: DEFAULT_SERIES_GAP_MINUTES,
  lastScheduledAt: null,
  noticedOff: [],
}

function key(setId: string | null | undefined): string {
  return `shots.composing.${setId ?? 'default'}`
}

/** The session's store, or null on the server and where storage is refused. */
function store(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    // Storage blocked by the browser: the composer still works, it just forgets.
    return null
  }
}

/** Read a string array from parsed JSON, dropping anything that is not a string. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** What this session remembers for a brand; the empty memory when it remembers nothing. */
export function readComposing(setId: string | null | undefined): ComposingMemory {
  const raw = store()?.getItem(key(setId))
  if (!raw) return EMPTY
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const gap = typeof parsed.gapMinutes === 'number' ? parsed.gapMinutes : NaN
    return {
      channelIds: strings(parsed.channelIds),
      gapMinutes:
        Number.isFinite(gap) && gap >= GAP_RANGE.min && gap <= GAP_RANGE.max
          ? gap
          : DEFAULT_SERIES_GAP_MINUTES,
      lastScheduledAt:
        typeof parsed.lastScheduledAt === 'string' ? parsed.lastScheduledAt : null,
      noticedOff: strings(parsed.noticedOff),
    }
  } catch {
    return EMPTY
  }
}

function write(setId: string | null | undefined, memory: ComposingMemory): void {
  try {
    store()?.setItem(key(setId), JSON.stringify(memory))
  } catch {
    // A full or refused store only costs the carry-over, never the draft.
  }
}

/**
 * The accounts a new draft in this brand should open on: the ones this
 * session last used, kept only while they are still connected. Undefined
 * when there is nothing to carry, which leaves the brand's own new-draft
 * defaults in charge.
 */
export function carriedChannels(
  set: { accounts: readonly { id: string }[]; id: string } | null | undefined
): string[] | undefined {
  if (!set) return undefined
  const live = new Set(set.accounts.map((account) => account.id))
  const kept = readComposing(set.id).channelIds.filter((id) => live.has(id))
  return kept.length ? kept : undefined
}

/** Keep the accounts a draft is publishing to, so the next new draft opens on them. */
export function rememberChannels(setId: string | null | undefined, channelIds: string[]): void {
  write(setId, { ...readComposing(setId), channelIds: [...channelIds] })
}

/**
 * Record a confirmed schedule. The gap between this time and the one before
 * it becomes the session's gap, so "every hour" or "every 20 minutes" is
 * learned from what the writer actually did rather than configured.
 */
export function rememberScheduled(
  setId: string | null | undefined,
  at: Date,
  channelIds: string[]
): void {
  const memory = readComposing(setId)
  const previous = memory.lastScheduledAt ? new Date(memory.lastScheduledAt) : null
  const minutes =
    previous && !Number.isNaN(previous.getTime())
      ? Math.round((at.getTime() - previous.getTime()) / 60_000)
      : NaN
  write(setId, {
    channelIds: channelIds.length ? [...channelIds] : memory.channelIds,
    gapMinutes:
      minutes >= GAP_RANGE.min && minutes <= GAP_RANGE.max ? minutes : memory.gapMinutes,
    lastScheduledAt: at.toISOString(),
    noticedOff: memory.noticedOff,
  })
}

/**
 * Whether the "switched off, no media yet" notice still needs showing for
 * these accounts, marking them shown. The switch itself always happens; only
 * the message is once per brand per session, so writing a run of text posts
 * does not repeat it on every draft.
 */
export function takeOffNotice(setId: string | null | undefined, accountIds: string[]): string[] {
  const memory = readComposing(setId)
  const fresh = accountIds.filter((id) => !memory.noticedOff.includes(id))
  if (fresh.length)
    write(setId, { ...memory, noticedOff: [...memory.noticedOff, ...fresh] })
  return fresh
}

/** Forget this brand's carry-over, so the next draft starts from the brand's defaults. */
export function clearComposing(setId: string | null | undefined): void {
  try {
    store()?.removeItem(key(setId))
  } catch {
    // Nothing to do: the memory is already unreachable.
  }
}
