import type { PillTone } from '@/components/platform-ui'

/**
 * How a scheduled destination reads to a person (RFC 013): its state,
 * including a queued post whose time passed without it starting, and why it
 * did not publish, in words they can act on. Pure, so the composer and the
 * calendar share it and plain Node tests it.
 */

/** A post's stored status. */
export type ScheduledPostStatus =
  | 'DRAFT'
  | 'SCHEDULED'
  | 'PROCESSING'
  | 'PUBLISHED'
  | 'FAILED'
  | 'CANCELLED'
  | 'UNKNOWN_DELIVERY'
  | 'SENT_TO_APP'

/**
 * The status filter's groups, which keep the names saved before the finer
 * states: overdue and publishing posts are scheduled; one that needs a check
 * is grouped with failures, as it was.
 */
export const STATUS_GROUPS = ['Planned', 'Scheduled', 'Published', 'Sent to app', 'Failed'] as const

/** The filter group a card state belongs to. */
export function statusGroup(state: string): string {
  if (state === 'Overdue' || state === 'Publishing') return 'Scheduled'
  if (state === 'Needs check') return 'Failed'
  return state
}

/**
 * What a person reads for one destination. "Sent to app" went to the
 * network's app as a draft (a TikTok app draft): the person finishes and posts
 * it there, so it is never published from Shots.
 */
export type PostState =
  | 'Scheduled'
  | 'Overdue'
  | 'Publishing'
  | 'Published'
  | 'Sent to app'
  | 'Failed'
  | 'Needs check'
  | 'Cancelled'

/**
 * A queued post this long past its time is overdue: the dispatcher starts
 * due posts every minute, so a longer wait means its worker is behind. After
 * an hour it is not sent at all (MISSED_WINDOW).
 */
export const OVERDUE_AFTER_MS = 5 * 60_000

/** The state of a destination at `now`. */
export function postState(
  status: ScheduledPostStatus,
  scheduledFor: string | Date,
  now = Date.now()
): PostState {
  switch (status) {
    case 'SCHEDULED':
    case 'DRAFT':
      return new Date(scheduledFor).getTime() + OVERDUE_AFTER_MS < now ? 'Overdue' : 'Scheduled'
    case 'PROCESSING':
      return 'Publishing'
    case 'PUBLISHED':
      return 'Published'
    case 'SENT_TO_APP':
      return 'Sent to app'
    case 'FAILED':
      return 'Failed'
    case 'UNKNOWN_DELIVERY':
      return 'Needs check'
    case 'CANCELLED':
      return 'Cancelled'
  }
}

/**
 * Each state's pill colour, the same in the composer, batch and calendar.
 * Scheduled and Publishing are both in flight with nothing wrong; their
 * words tell them apart.
 */
export const POST_STATE_TONE: Record<PostState, PillTone> = {
  Cancelled: 'gray',
  Failed: 'red',
  'Needs check': 'yellow',
  Overdue: 'yellow',
  Published: 'green',
  Publishing: 'blue',
  Scheduled: 'blue',
  'Sent to app': 'purple',
}

/** Which state a draft shows first: the one that needs a person soonest. */
const ATTENTION: PostState[] = [
  'Needs check',
  'Failed',
  'Overdue',
  'Publishing',
  'Scheduled',
  // Ahead of what went live: the person still finishes it in the app.
  'Sent to app',
  'Published',
]

/**
 * A draft's destinations in one state, the one that needs attention first,
 * with how many of its live destinations are in it. Cancelled posts (replaced
 * or stopped) do not count; a draft with only those has none.
 */
export function draftPostsState(
  posts: { status: ScheduledPostStatus; scheduledFor: string | Date }[],
  now = Date.now()
): { state: PostState; count: number; total: number } | null {
  const states: PostState[] = posts
    .map((post) => postState(post.status, post.scheduledFor, now))
    .filter((state) => state !== 'Cancelled')
  const state = ATTENTION.find((candidate) => states.includes(candidate))
  if (!state) return null
  return { state, count: states.filter((item) => item === state).length, total: states.length }
}

/**
 * A draft's posts without the failures a newer post of the same destination
 * replaced: a retry is a new post, so the failure before it is history. An
 * unconfirmed post always stays: it may be live until someone checks. The
 * backend's list counts read the same way.
 */
export function currentPosts<
  T extends {
    channelConnectionId: string
    createdAt: string | Date
    status: ScheduledPostStatus
  },
>(posts: T[]): T[] {
  return posts.filter(
    (post) =>
      post.status !== 'FAILED' ||
      !posts.some(
        (other) =>
          other.channelConnectionId === post.channelConnectionId &&
          other.status !== 'CANCELLED' &&
          new Date(other.createdAt).getTime() > new Date(post.createdAt).getTime()
      )
  )
}

/** How many destinations are in a state, in the words every surface uses. */
export function stateLabel(state: PostState, count: number, total: number): string {
  return count < total ? `${state} · ${count} of ${total}` : state
}

/**
 * The one status a draft reads as in its header and its details: a failed or
 * unconfirmed post first, as the drafts list shows it, even when archived (it
 * may be live); else archived; else its destinations' state; else a plan.
 * It is derived from the posts each time, never from a stored draft status.
 */
export function draftStatus(
  draft: { status: string; plannedFor: string | Date | null },
  destinations: { state: PostState; count: number; total: number } | null
): { label: string; tone: PillTone } | null {
  const attention = destinations?.state === 'Needs check' || destinations?.state === 'Failed'
  if (draft.status === 'archived' && !attention) return { label: 'Archived', tone: 'gray' }
  if (destinations)
    return {
      label: stateLabel(destinations.state, destinations.count, destinations.total),
      tone: POST_STATE_TONE[destinations.state],
    }
  return draft.plannedFor ? { label: 'Planned', tone: 'purple' } : null
}

/**
 * A listed draft's state that needs a person, from the list's counts: the
 * list has no post rows, so it reads the same words from the totals.
 */
export function listedAttention(counts: {
  attentionPosts: number
  checkPosts: number
  publishedPosts: number
  queuedPosts: number
  sentToAppPosts: number
}): { state: PostState; count: number; total: number } | null {
  if (counts.attentionPosts === 0) return null
  const check = counts.checkPosts > 0
  return {
    count: check ? counts.checkPosts : counts.attentionPosts,
    state: check ? 'Needs check' : 'Failed',
    total:
      counts.attentionPosts + counts.queuedPosts + counts.publishedPosts + counts.sentToAppPosts,
  }
}

/** A listed draft's one word: what needs a person, else how far its posts have gone. */
export function listedStatus(draft: {
  attentionPosts: number
  checkPosts: number
  publishedPosts: number
  queuedPosts: number
  sentToAppPosts: number
  status: string
}): string {
  const attention = listedAttention(draft)
  if (attention) return attention.state
  if (draft.status === 'archived') return 'Archived'
  if (draft.queuedPosts > 0) return 'Scheduled'
  // Posting it in the app is still to do, as in draftPostsState.
  if (draft.sentToAppPosts > 0) return 'Sent to app'
  return draft.publishedPosts > 0 ? 'Published' : 'Draft'
}

/**
 * The one next step for a failure: reconnect the account, reschedule (retry
 * now or later), edit the post or its options, edit its media, or check the
 * account before anything else (the platform may already have the post).
 */
export type PostFailureAction = 'check-account' | 'edit' | 'edit-media' | 'reconnect' | 'reschedule'

/**
 * Each failure code the backend records (`server/internal/publishing/types.go`
 * and provider statuses) with the one message a member sees and the one next
 * action. Raw provider text is never shown; it stays on the attempt for support.
 */
const POST_FAILURES: Record<string, { action: PostFailureAction | null; reason: string }> = {
  MEDIA_UNAVAILABLE: {
    action: 'edit-media',
    reason:
      'An attachment was deleted or is unavailable, so nothing was sent. Restore it and schedule again.',
  },
  MISSED_WINDOW: {
    action: 'reschedule',
    reason:
      'Publishing could not start within an hour of its time, so it was not sent. Publish it now or reschedule it.',
  },
  CHANGES_REQUESTED: {
    action: 'edit',
    reason:
      'A reviewer asked for changes, so it was not sent. Revise it, get it approved, then schedule again.',
  },
  APPROVAL_REQUIRED: {
    action: 'edit',
    reason:
      'Its content is no longer approved, so it was not sent. Get it approved, then schedule again.',
  },
  NOT_LIVE: {
    action: 'reschedule',
    reason: 'Checked on the account: it was not published. Retry it.',
  },
  ACCOUNT_UNAVAILABLE: {
    action: 'reconnect',
    reason:
      'The account was disconnected or removed, so it was not sent. Reconnect it, then schedule again.',
  },
  SCHEDULER_UNAUTHORIZED: {
    action: 'reschedule',
    reason:
      'The person who scheduled it can no longer publish here, so it was not sent. Someone who can publish should schedule it again.',
  },
  WORKSPACE_INACTIVE: {
    action: null,
    reason: 'The workspace or this content is no longer active, so it was not sent.',
  },
  UNKNOWN_DELIVERY: {
    action: 'check-account',
    reason:
      'The platform did not confirm the result. It may already be live: check the account before doing anything.',
  },
  ACCOUNT_RECONNECT: {
    action: 'reconnect',
    reason: 'The account must be reconnected, so nothing was sent. Reconnect it, then retry.',
  },
  PROVIDER_PERMISSIONS: {
    action: 'reconnect',
    reason:
      'The platform did not return this account’s posting permissions. Retry it. If it fails again, reconnect the account.',
  },
  PROVIDER_DAILY_LIMIT: {
    action: 'reschedule',
    reason:
      'The account reached the platform’s daily posting limit, so nothing was sent. Reschedule it for after the limit resets.',
  },
  POST_OPTIONS: {
    action: 'edit',
    reason:
      'This account cannot post with these options, so nothing was sent. Change the platform options, then retry.',
  },
  VIDEO_TOO_LONG: {
    action: 'edit-media',
    reason:
      'The video is longer than this account may post, so nothing was sent. Use a shorter video, then retry.',
  },
  MEDIA_UNSUPPORTED: {
    action: 'edit-media',
    reason:
      'This platform takes one MP4 video, so nothing was sent. Replace the media, then retry.',
  },
  PUBLISHER_UNAVAILABLE: {
    action: 'reschedule',
    reason:
      'Shots could not reach its publishing service, so nothing was sent. Retry it later, or send the details to support.',
  },
  PUBLISHER_ERROR: {
    action: 'reschedule',
    reason:
      'Shots stopped before it handed the post to the platform, so nothing was sent. Retry it. If it fails again, copy the details below for support.',
  },
  UNKNOWN: {
    action: 'reschedule',
    reason:
      'Shots stopped before it handed the post to the platform, so nothing was sent. Retry it. If it fails again, copy the details below for support.',
  },
  NETWORK: { action: 'reschedule', reason: 'The platform could not be reached. Retry it.' },
  '429': {
    action: 'reschedule',
    reason:
      'The platform kept rate-limiting this post, so nothing was sent. Reschedule it, or retry it later.',
  },
  '401': {
    action: 'reconnect',
    reason: 'The platform refused the account’s permission. Reconnect it, then retry.',
  },
  '403': {
    action: 'reconnect',
    reason: 'The platform refused the account’s permission. Reconnect it, then retry.',
  },
}

/** The known entry for a code, or the rule for a bare provider status. */
function postFailure(code: string): { action: PostFailureAction | null; reason: string } {
  const known = POST_FAILURES[code]
  if (known) return known
  if (/^5\d\d$/.test(code))
    return { action: 'reschedule', reason: 'The platform had an error. Retry it.' }
  if (/^4\d\d$/.test(code))
    return {
      action: 'edit',
      reason: 'The platform rejected the post. Check its text and media before retrying.',
    }
  return { action: null, reason: `It did not publish (${code}).` }
}

/** The one next action for a failure, or null when there is none to take. */
export function postFailureFix(code: string | null | undefined): PostFailureAction | null {
  return code ? postFailure(code).action : null
}

/**
 * Whether a retry could work. A retry resends the post as it was scheduled, so
 * a failure the post itself caused comes back until it is edited and scheduled
 * again.
 */
export function retryCanHelp(code: string | null | undefined): boolean {
  const fix = postFailureFix(code)
  return fix !== 'edit' && fix !== 'edit-media'
}

/** Why a destination did not publish, or null when nothing went wrong. */
export function postFailureReason(code: string | null | undefined): string | null {
  return code ? postFailure(code).reason : null
}
