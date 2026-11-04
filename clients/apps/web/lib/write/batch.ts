import type { BatchItem, BatchTiming } from '@/lib/api/contracts/content-batches'
import { DRAFT_CHANNEL_LIMITS, platformCaptionLength } from '@/lib/content-drafts/serialize'
import { zonedDayKey } from '@/lib/settings/zoned-time'
import type { AccountStanding } from '@/lib/write/capabilities'
import type { DraftChannel, VersionOptions } from '@/lib/write/document'
import { mediaChanges, mediaProblems, type MediaFacts } from '@/lib/write/media-rules'
import { analyzeSpintax } from '@/lib/write/spintax'
import { readVersions, withOptions } from '@/lib/write/versions'
import { resolveLocalTime, wallTime } from '@/lib/write/zoned-time'

/**
 * Bulk batch view logic (RFC 042), kept apart from the page so it can be
 * tested: which item and account combinations can go, when each item is
 * meant to go out, and what happened to each one after scheduling.
 */

/** An account of the batch's set that an item can go to. */
export type BatchAccount = {
  channel: DraftChannel
  id: string
  name: string
  /** This account's own caption limit, when it differs from its channel's. */
  captionLimit?: number
  tiktokCreator?: AccountStanding['tiktokCreator']
}

/**
 * An item's media facts once every attachment is uploaded; null while one is
 * not, so nothing is judged on partial facts.
 */
export function batchMediaFacts(media: BatchItem['media']): MediaFacts[] | null {
  const facts: MediaFacts[] = []
  for (const item of media) {
    if (item.status !== 'UPLOADED' || !item.mediaType) return null
    facts.push({
      bytes: item.bytes,
      durationMs: item.durationMs,
      height: item.height,
      mimeType: item.mediaType,
      width: item.width,
    })
  }
  return facts
}

/** A PDF item goes to LinkedIn alone, as the post's document. */
function documentProblems(channel: DraftChannel, facts: MediaFacts[]) {
  if (channel !== 'linkedin')
    return ['Only LinkedIn posts a PDF, as a document. Remove this account or the PDF.']
  if (facts.length > 1)
    return ['A LinkedIn document goes alone: remove the images or the document.']
  return []
}

/**
 * For each chosen account: what blocks the item there, from the media rules
 * Go also applies, and what Shots would change before sending it.
 */
export function stagedChecks(item: BatchItem, accounts: BatchAccount[]) {
  const facts = batchMediaFacts(item.media)
  const pdf = facts?.some((fact) => fact.mimeType === 'application/pdf')
  return new Map(
    accounts
      .filter((account) => item.channelConnectionIds.includes(account.id))
      .map((account) => [
        account.id,
        {
          changes: facts && !pdf ? mediaChanges(account.channel, facts) : [],
          problems: !facts
            ? ['Finish uploading this item’s files first.']
            : pdf
              ? documentProblems(account.channel, facts)
              : mediaProblems(account.channel, facts),
        },
      ])
  )
}

/**
 * Whether a caption source's longest expansion fits every account given, or
 * what to shorten. Literal captions, variations and CSV rows all come here.
 */
export function captionProblem(source: string, accounts: readonly BatchAccount[]) {
  for (const account of accounts) {
    const measure = (text: string) => platformCaptionLength(account.channel, text)
    const limit = account.captionLimit ?? DRAFT_CHANNEL_LIMITS[account.channel]
    const length = measure(analyzeSpintax(source, measure).longest)
    if (length > limit)
      return `The longest caption is ${length} characters, and ${account.name} takes ${limit}. Shorten it or remove this account.`
  }
}

/** A grid video concept whose video is not made yet; it cannot become a draft. */
export function waitingToRender(item: Pick<BatchItem, 'draftId' | 'grid' | 'media'>) {
  return Boolean(item.grid && !item.draftId && !item.media.length)
}

/** A YouTube title for an item: its caption's first line, else the name of its file. */
function videoTitle(item: BatchItem) {
  const name = (item.sourceKey || item.media[0]?.fileName || '').replace(/\.[^.]+$/, '')
  const line = item.caption.trim().split('\n')[0] ?? ''
  return (line.length >= 2 ? line : name).replace(/[<>]/g, '').slice(0, 100).trim()
}

/**
 * The platform versions a staged item's draft starts with: its LinkedIn
 * document, and the batch's YouTube and TikTok options for the channels the
 * item goes to. A title chosen for the batch wins; otherwise each post has its
 * own. Options are edited per post in Write from then on.
 */
export function stagedVersions(
  item: BatchItem,
  channels: readonly DraftChannel[],
  options: VersionOptions
) {
  const pdf = item.media.find((entry) => entry.mediaType === 'application/pdf')
  let versions = readVersions(undefined)
  let changed = false
  if (pdf?.assetId) {
    versions = withOptions(versions, 'linkedin', {
      document: {
        assetId: pdf.assetId,
        title: pdf.fileName?.replace(/\.pdf$/i, '').slice(0, 200) || 'Document',
      },
    })
    changed = true
  }
  if (channels.includes('youtube') && options.youtube) {
    const title = options.youtube.title.trim() || videoTitle(item)
    versions = withOptions(versions, 'youtube', { youtube: { ...options.youtube, title } })
    changed = true
  }
  if (channels.includes('tiktok') && options.tiktok) {
    versions = withOptions(versions, 'tiktok', { tiktok: options.tiktok })
    changed = true
  }
  return changed ? versions : undefined
}

/** The hours between posts that keep a day's posts inside its 24 hours. */
export function spreadHourOptions(postsPerDay: number) {
  return [1, 2, 3, 4, 6, 8, 12, 24].filter((hours) => hours * postsPerDay <= 24)
}

/** What a batch will do once scheduled, in real instants and calendar days of `zone`. */
export function batchSummary(items: readonly BatchItem[], zone: string, now = new Date()) {
  const instants = items.flatMap((item) => {
    const timing = readTiming(item.timing, now)
    return timing.kind === 'at' ? [timing.at] : []
  })
  const times = instants.map((at) => at.getTime())
  return {
    calendarDays: new Set(instants.map((at) => zonedDayKey(at, zone))).size,
    destinations: items.reduce((total, item) => total + itemAccounts(item).length, 0),
    first: times.length ? new Date(Math.min(...times)) : null,
    last: times.length ? new Date(Math.max(...times)) : null,
    posts: items.length,
    withoutTime: items.length - instants.length,
  }
}

/** When an item is meant to go out, or why that cannot be read yet. */
export type TimingView =
  | { kind: 'unset'; text: string }
  | { at: Date; kind: 'at'; text: string; zone: string }
  | { kind: 'problem'; text: string }

/** Read an item's intended time as the backend will, in its own zone. */
export function readTiming(timing: BatchTiming, now = new Date()): TimingView {
  if (timing.mode === 'queue') {
    if (!timing.expectedQueueSlot)
      return { kind: 'problem', text: 'Preview the queue to give this item a slot.' }
    const at = new Date(timing.expectedQueueSlot)
    return { at, kind: 'at', text: 'Next free queue slot', zone: '' }
  }
  if (timing.mode !== 'time' || !timing.localTime || !timing.timeZone)
    return { kind: 'unset', text: 'Choose a time or the queue.' }
  const resolved = resolveLocalTime(timing.localTime, timing.timeZone)
  if (resolved.kind === 'gap')
    return {
      kind: 'problem',
      text: `${timing.localTime.replace('T', ' ')} doesn’t exist in ${timing.timeZone}: the clocks skip it. Pick another time.`,
    }
  const at =
    resolved.kind === 'exact'
      ? resolved.at
      : timing.disambiguation
        ? resolved[timing.disambiguation]
        : null
  if (!at)
    return {
      kind: 'problem',
      text: `${timing.localTime.replace('T', ' ')} happens twice in ${timing.timeZone} as the clocks go back. Choose the earlier or the later one.`,
    }
  if (at.getTime() <= now.getTime() + 60_000)
    return { kind: 'problem', text: 'Pick a time in the future.' }
  return { at, kind: 'at', text: timing.localTime.replace('T', ' '), zone: timing.timeZone }
}

/** Previewed Spread instants as wall times in the batch's zone, kept with the zone. */
export function spreadTimings(times: string[], zone: string): BatchTiming[] {
  return times.map((at) => ({
    mode: 'time',
    localTime: wallTime(new Date(at), zone),
    timeZone: zone,
  }))
}

/** Previewed queue slots, sent back so a slot taken meanwhile is refused, not moved. */
export function queueTimings(times: string[]): BatchTiming[] {
  return times.map((at) => ({ mode: 'queue', expectedQueueSlot: at }))
}

/**
 * What happened to an item on one account: its newest scheduled post that
 * was not cancelled, or none. Status comes from the post, the one record.
 */
export function postOn(item: BatchItem, accountId: string) {
  return (
    item.posts
      .filter((post) => post.channelConnectionId === accountId && post.status !== 'CANCELLED')
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null
  )
}

/**
 * The accounts an item is meant for: those chosen in the batch and any its
 * draft gained since. Scheduling some of them narrows the draft's list to
 * what was scheduled, so the batch keeps the rest to check and send later.
 */
export function itemAccounts(item: BatchItem): string[] {
  return [...new Set([...item.channelConnectionIds, ...(item.draft?.channelConnectionIds ?? [])])]
}

/** The accounts an item still needs scheduled to, and whether it already has live posts. */
export function pendingAccounts(item: BatchItem, accountIds: string[]) {
  const live = accountIds.filter((id) => {
    const post = postOn(item, id)
    return post && post.status !== 'FAILED'
  })
  return {
    add: item.posts.some((post) => post.status !== 'CANCELLED' && post.status !== 'FAILED'),
    remaining: accountIds.filter((id) => !live.includes(id)),
  }
}
