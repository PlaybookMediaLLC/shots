import type { BatchItem, BatchRun, BatchTiming } from '@/lib/api/contracts/content-batches'
import { postState } from '@/lib/content-drafts/post-status'
import { DRAFT_CHANNEL_LIMITS, platformCaptionLength } from '@/lib/content-drafts/serialize'
import { zonedDayKey } from '@/lib/settings/zoned-time'
import { assetContentUrl } from '@/lib/editor/asset-url'
import type { AccountStanding } from '@/lib/write/capabilities'
import type { DraftChannel, PlateBody, VersionOptions } from '@/lib/write/document'
import { importedBody, importedPosts } from '@/lib/write/import-text'
import { LABELS, mediaChanges, mediaProblems, type MediaFacts } from '@/lib/write/media-rules'
import { buildPublication, type Publication } from '@/lib/write/publication'
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
  /** How the account is shown beside a post: its avatar, handle, else its display name. */
  avatarUrl?: string | null
  displayName?: string | null
  handle?: string | null
  /** This account's own caption limit, when it differs from its channel's. */
  captionLimit?: number
  tiktokCreator?: AccountStanding['tiktokCreator']
  /** An X account's own limit, which the preview counts against. */
  xCaptionLimit?: AccountStanding['maxWeightedCharacters']
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
export function stagedChecks(item: BatchItem, accounts: readonly BatchAccount[]) {
  const facts = batchMediaFacts(item.media)
  const pdf = facts?.some((fact) => fact.mimeType === 'application/pdf')
  return new Map(
    accounts
      .filter((account) => item.channelConnectionIds.includes(account.id))
      .map((account) => [
        account.id,
        {
          changes: facts && !pdf ? mediaChanges(account.channel, facts) : [],
          problems: waitingToRender(item)
            ? ['Render this video first.']
            : !facts
              ? ['Finish uploading this item’s files first.']
              : pdf
                ? documentProblems(account.channel, facts)
                : mediaProblems(account.channel, facts),
        },
      ])
  )
}

/**
 * A preview row's files against its accounts' platforms before anything
 * uploads, on the facts the browser has: type and size. A row no account can
 * take needs fixing; one that only some refuse is added, with a note saying
 * what they refuse. Length and shape are known once uploaded, so Check judges
 * those, and a row with a library asset or an untyped file is left to it.
 */
export function intakeChecks(
  channels: readonly DraftChannel[],
  files: readonly ({ size: number; type: string } | undefined)[]
): { notes: string[]; problems: string[] } {
  const facts: MediaFacts[] = []
  for (const file of files) {
    if (!file?.type) return { notes: [], problems: [] }
    facts.push({ bytes: file.size, mimeType: file.type })
  }
  const pdf = facts.some((fact) => fact.mimeType === 'application/pdf')
  const platforms = [...new Set(channels)]
  const refusals = facts.length
    ? platforms.flatMap((channel) =>
        (pdf ? documentProblems(channel, facts) : mediaProblems(channel, facts)).slice(0, 1)
      )
    : []
  // A PDF's refusal reads the same for every platform but LinkedIn: say it once.
  const said = [...new Set(refusals)]
  return refusals.length && refusals.length === platforms.length
    ? { notes: [], problems: said }
    : { notes: said, problems: [] }
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

/**
 * The body a staged item's draft starts with: its caption as posts (a line of
 * --- starts the next), then each uploaded attachment. Saving and the preview
 * both build it here, so the preview shows what the draft will hold.
 */
export function stagedBody(item: Pick<BatchItem, 'caption' | 'media'>): PlateBody {
  const posts = importedPosts(item.caption)
  const body = importedBody(posts.length ? posts : [''])
  const pdf = item.media.find((entry) => entry.mediaType === 'application/pdf')
  for (const entry of item.media)
    if (entry.assetId)
      body.push({
        type: entry === pdf ? 'file' : entry.mediaType?.startsWith('video/') ? 'video' : 'img',
        assetId: entry.assetId,
        url: assetContentUrl(entry.assetId),
        ...(entry.mediaType ? { mimeType: entry.mediaType } : {}),
        name: entry.fileName ?? '',
        children: [{ text: '' }],
      })
  return body
}

/**
 * What each of an item's accounts would show, built as saving its draft
 * builds it: the same body, platform versions and publication. A caption a
 * draft cannot hold, such as a thread of more than 25 posts, comes back as
 * `problem`, as saving reports it. A saved draft may have changed in Write
 * since; its own preview there is exact.
 */
export function previewPublications(
  item: BatchItem,
  accounts: readonly BatchAccount[],
  options: VersionOptions
): { cards: { account: BatchAccount; publication: Publication }[]; problem?: string } {
  const ids = itemAccounts(item)
  const chosen = accounts.filter((account) => ids.includes(account.id))
  let body: PlateBody
  try {
    body = stagedBody({ caption: item.draft?.plainText ?? item.caption, media: item.media })
  } catch (error) {
    return { cards: [], problem: error instanceof Error ? error.message : String(error) }
  }
  const draft = {
    article: null,
    body,
    kind: 'standard' as const,
    platformVersions:
      stagedVersions(
        item,
        chosen.map((account) => account.channel),
        options
      ) ?? readVersions(undefined),
    target: null,
  }
  return {
    cards: chosen.map((account) => ({
      account,
      publication: buildPublication(draft, {
        channel: account.channel,
        connectionId: account.id,
        standing: {
          maxWeightedCharacters: account.xCaptionLimit,
          tiktokCreator: account.tiktokCreator,
        },
      }),
    })),
  }
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

/**
 * Who a batch reaches, counted as people read it: "3 posts to 1 X account",
 * not three destinations, when three posts go to the same account.
 */
export function batchAudience(
  items: readonly BatchItem[],
  accounts: readonly Pick<BatchAccount, 'channel' | 'id'>[]
): string {
  const ids = [...new Set(items.flatMap(itemAccounts))]
  const posts = `${items.length} post${items.length === 1 ? '' : 's'}`
  if (ids.length === 0) return `${posts}, no account chosen`
  const channel = accounts.find((account) => account.id === ids[0])?.channel
  if (ids.length === 1) return `${posts} to 1 ${channel ? `${LABELS[channel]} ` : ''}account`
  const pairs = items.reduce((total, item) => total + itemAccounts(item).length, 0)
  return `${posts} to ${ids.length} accounts${pairs === items.length ? '' : `, ${pairs} in all`}`
}

/**
 * The hourly preset: one post an hour from the window's start to its end
 * (both "HH:mm"), as the spread planner's posts per day. Posts past the end
 * go to the next day at the start time. Null unless the end is after the start.
 */
export function hourlyWindow(start: string, end: string): number | null {
  const minutes = (time: string) => {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time)
    return match ? Number(match[1]) * 60 + Number(match[2]) : null
  }
  const from = minutes(start)
  const to = minutes(end)
  if (from === null || to === null || to <= from) return null
  return Math.min(24, Math.floor((to - from) / 60) + 1)
}

/**
 * Whether a draft's body is still the plain single post a batch made: one
 * post of unformatted paragraphs. Only then can its words be replaced from
 * the batch without losing a thread, media, formatting or a post's settings.
 */
export function plainTextDraft(body: unknown): boolean {
  if (!Array.isArray(body)) return false
  const plainNode = (node: unknown, type: string) =>
    typeof node === 'object' &&
    node !== null &&
    (node as { type?: unknown }).type === type &&
    Object.keys(node).every((key) => key === 'id' || key === 'type' || key === 'children')
  const plainLeaf = (leaf: unknown) =>
    typeof leaf === 'object' &&
    leaf !== null &&
    typeof (leaf as { text?: unknown }).text === 'string' &&
    Object.keys(leaf).length === 1
  return (
    body.filter((node) => plainNode(node, 'post_break')).length <= 1 &&
    body.every(
      (node) =>
        plainNode(node, 'post_break') ||
        (plainNode(node, 'p') &&
          Array.isArray((node as { children?: unknown }).children) &&
          ((node as { children: unknown[] }).children).every(plainLeaf))
    )
  )
}

/** When an item is meant to go out, or why that cannot be read yet. */
export type TimingView =
  | { kind: 'unset'; text: string }
  | { at: Date; kind: 'at'; text: string; zone: string }
  | { kind: 'problem'; text: string }

/**
 * A batch's posts on one platform, in list order, as its feed preview shows
 * them: each post that goes to an account there, built as previewPublications
 * builds it, with when it goes out there. A post the preview cannot build is
 * left out and counted in `refused`.
 */
export function feedPublications(
  items: readonly BatchItem[],
  accounts: readonly BatchAccount[],
  options: VersionOptions,
  channel: DraftChannel,
  zone: string
) {
  let refused = 0
  const posts = items.flatMap((item, index) => {
    const ids = itemAccounts(item)
    const account = accounts.find(
      (candidate) => candidate.channel === channel && ids.includes(candidate.id)
    )
    if (!account) return []
    const [card] = previewPublications(item, [account], options).cards
    if (!card) {
      refused += 1
      return []
    }
    return [
      {
        card,
        key: item.id,
        // A grid video has no picture until it is rendered: the feed says so beside it.
        label: waitingToRender(item) ? 'Not rendered yet' : plannedText(item, zone, [account.id]),
        name: `Post ${index + 1}`,
      },
    ]
  })
  return { posts, refused }
}

/** A moment as a short date and time in a zone, such as 'Nov 13, 9:30 AM'. */
export function shortWhen(at: Date | string, zone: string) {
  const date = typeof at === 'string' ? new Date(at) : at
  return date.toLocaleString(undefined, {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    timeZone: zone || undefined,
  })
}

/**
 * When an item goes out, as its row and the feed preview say it. Once every
 * account given has a post, the scheduler's answer; else the proposal
 * (Planned for, or the next queue slot), else what is missing. Only the
 * scheduler's answer says Scheduled. The row asks about all its accounts; the
 * feed asks about the one account it shows.
 */
export function plannedText(
  item: BatchItem,
  zone: string,
  accountIds: string[] = itemAccounts(item)
): string {
  const live =
    accountIds.length > 0 && pendingAccounts(item, accountIds).remaining.length === 0
      ? accountIds.map((id) => postOn(item, id)).find(Boolean)
      : undefined
  if (live)
    return `${postState(live.status, live.scheduledFor)} · ${shortWhen(live.scheduledFor, live.scheduleTimeZone ?? zone)}`
  const timing = readTiming(item.timing)
  if (timing.kind === 'at')
    return item.timing.mode === 'queue'
      ? `Next queue slot: ${shortWhen(timing.at, zone)}`
      : `Planned for ${shortWhen(timing.at, timing.zone || zone)}`
  return timing.kind === 'problem' ? timing.text : 'No time yet'
}

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

/** Whether a draft already has queued or sent posts, so a new account goes beside them. */
export function hasLivePosts(posts: readonly { status: string }[]) {
  return posts.some((post) => post.status !== 'CANCELLED' && post.status !== 'FAILED')
}

/** What a schedule run did to each item, in words for the page. */
export function runOutcomes(run: Pick<BatchRun, 'items'> | null | undefined) {
  return Object.fromEntries(
    (run?.items ?? []).map((item) => [
      item.itemId,
      item.status === 'DONE'
        ? 'Scheduled'
        : item.status === 'PENDING'
          ? 'Waiting to be scheduled…'
          : (item.error ?? 'This post was not scheduled.'),
    ])
  )
}

/** The accounts an item still needs scheduled to, and whether it already has live posts. */
export function pendingAccounts(item: BatchItem, accountIds: string[]) {
  const live = accountIds.filter((id) => {
    const post = postOn(item, id)
    return post && post.status !== 'FAILED'
  })
  return {
    add: hasLivePosts(item.posts),
    remaining: accountIds.filter((id) => !live.includes(id)),
  }
}
