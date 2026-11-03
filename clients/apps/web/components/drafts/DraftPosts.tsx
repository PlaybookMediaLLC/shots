'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Pill } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { type DraftPostWire, draftsApi } from '@/lib/content-drafts/client'
import { writeApi } from '@/lib/write/client'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { POST_STATE_TONE, postFailureReason, postState } from '@/lib/content-drafts/post-status'
import { channelForPlatform } from '@/lib/content-drafts/serialize'
import { cn } from '@/lib/utils'
import { CHANNEL_META, ChannelIcon } from './channel-meta'
import { POST_COLUMN } from './layout'
import { LocalTime } from './local-time'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

/** The engagement counts the posts list shows, in order, with their labels. */
const METRICS: [string, string][] = [
  ['likes', 'likes'],
  ['reposts', 'reposts'],
  ['replies', 'replies'],
  ['impressions', 'views'],
]

/** A post's time in the zone it was scheduled in, named, so it matches the review and calendar. */
function zoned(post: DraftPostWire, seconds = false): Intl.DateTimeFormatOptions {
  return {
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    ...(seconds ? { second: '2-digit' } : {}),
    timeZone: post.scheduleTimeZone ?? undefined,
    timeZoneName: 'short',
    year: 'numeric',
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

/**
 * The posts a draft became: when and where each goes out, a link to it once
 * live with its engagement, a thread that stopped partway with the rest one
 * click away, and a queued post's cancel.
 */
export function DraftPosts({
  canSchedule,
  edited,
  onCancel,
  onChange,
  onReschedule,
  posts,
}: {
  canSchedule: boolean
  /** Queued posts whose content the draft has changed since: they still send what was scheduled. */
  edited?: ReadonlySet<string>
  onCancel: (postId: string) => Promise<void>
  /** Open the reschedule review that replaces the queued posts with the current text. */
  onReschedule?: () => void
  /** Called with a post as the server now has it, or a new one. */
  onChange: (post: DraftPostWire) => void
  posts: DraftPostWire[]
}) {
  const [busy, setBusy] = React.useState<string | null>(null)
  const run = async (id: string, action: () => Promise<{ post: DraftPostWire }>, done: string) => {
    setBusy(id)
    try {
      onChange((await action()).post)
      toast.success(done)
    } catch (error) {
      toast.error(message(error))
    } finally {
      setBusy(null)
    }
  }
  if (posts.length === 0) return null
  return (
    <section className={cn('mb-10', POST_COLUMN)}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Posts from this draft
        </h2>
        {onReschedule ? (
          <Button onClick={onReschedule} size="sm" variant="outline">
            Replace queued posts with this version…
          </Button>
        ) : null}
      </div>
      <ul className="divide-y divide-foreground/[0.05] rounded-xl border border-foreground/[0.06]">
        {posts.map((post) => {
          const channel = channelForPlatform(post.platform)
          const stopped =
            post.status === 'PUBLISHED' &&
            post.threadProgress.total > 0 &&
            post.threadProgress.posted < post.threadProgress.total
          const counts = METRICS.filter(([key]) => post.metrics?.[key] !== undefined)
          const state = postState(post.status, post.scheduledFor)
          const overdue = state === 'Overdue'
          const reason = postFailureReason(post.failureCode)
          const label = channel ? CHANNEL_META[channel].label : post.platform
          return (
            <li className="flex flex-col gap-2 px-4 py-3" data-testid="draft-post" key={post.id}>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm text-foreground">
                    {channel ? <ChannelIcon channel={channel} /> : null}
                    {label} ·{' '}
                    <LocalTime
                      options={zoned(post, Boolean(post.naturalOffsetSeconds))}
                      value={post.scheduledFor}
                    />
                    {post.naturalOffsetSeconds ? (
                      <span className="text-xs text-muted-foreground">
                        (natural time; slot{' '}
                        <LocalTime options={zoned(post)} value={post.slotAt ?? post.scheduledFor} />)
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{post.caption}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Pill tone={POST_STATE_TONE[state]}>{state}</Pill>
                  {post.url ? (
                    <a
                      className="text-xs text-sky-700 dark:text-sky-300 hover:text-sky-700 dark:hover:text-sky-200"
                      href={post.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      View post
                    </a>
                  ) : null}
                  {canSchedule && (post.status === 'SCHEDULED' || post.status === 'DRAFT') ? (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button aria-label={`Cancel the ${label} post`} size="sm" variant="outline">
                          Cancel
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Cancel the {label} post?</AlertDialogTitle>
                          <AlertDialogDescription>
                            It will not publish at{' '}
                            <LocalTime options={zoned(post)} value={post.scheduledFor} />. The
                            draft&rsquo;s other destinations stay queued, and you can schedule
                            this one again.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Keep it queued</AlertDialogCancel>
                          <AlertDialogAction onClick={() => void onCancel(post.id)}>
                            Cancel this post
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  ) : null}
                  {canSchedule && post.status === 'SCHEDULED' ? (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button disabled={busy !== null} size="sm" variant="outline">
                          Publish now
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Publish this queued post now?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This publishes the content saved when you scheduled this destination and
                            replaces its timer. Later draft edits are not included. Approval and
                            account access will be checked again.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <p className="max-h-40 overflow-auto whitespace-pre-wrap text-sm">
                          {post.caption}
                        </p>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Keep scheduled</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() =>
                              void run(
                                post.id,
                                async () => {
                                  const result = await draftsApi.publishQueuedPost(post.id)
                                  onChange({ ...post, status: 'CANCELLED' })
                                  return result
                                },
                                'Publishing this destination now.'
                              )
                            }
                          >
                            Confirm publish now
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  ) : null}
                </div>
              </div>
              {post.status === 'SCHEDULED' && edited?.has(post.id) ? (
                <p className="text-xs text-muted-foreground" data-testid="queued-snapshot">
                  Queued with the text from when it was scheduled. Later edits are not in this post
                  until you reschedule.
                </p>
              ) : null}
              {overdue ? (
                <p className="text-xs text-amber-700 dark:text-amber-300" role="status">
                  Its time passed and publishing has not started yet. It still goes out if it starts
                  within an hour of its time; after that it is not sent and shows as failed.
                </p>
              ) : null}
              {post.status === 'PUBLISHED' && post.publishedAt ? (
                <p className="text-xs text-muted-foreground">
                  Confirmed live <LocalTime value={post.publishedAt} />
                </p>
              ) : null}
              {post.status === 'CANCELLED' && reason ? (
                <p className="text-xs text-muted-foreground" role="status">
                  Cancelled before sending. {reason}
                </p>
              ) : null}
              {post.status === 'FAILED' ? (
                <p className="flex flex-wrap items-center gap-2 text-xs text-red-700 dark:text-red-300" role="status">
                  {reason ? `${reason} ` : ''}This destination did not publish; the draft’s other
                  posts are unaffected.
                  {canSchedule ? (
                    <Button
                      disabled={busy === post.id}
                      onClick={() =>
                        void run(
                          post.id,
                          () => writeApi.retryPost(post.id),
                          'Retrying this destination now.'
                        )
                      }
                      size="sm"
                      variant="outline"
                    >
                      Retry this destination
                    </Button>
                  ) : null}
                </p>
              ) : null}
              {post.status === 'UNKNOWN_DELIVERY' ? (
                <div
                  className="flex flex-wrap items-center gap-2 text-xs text-amber-700 dark:text-amber-300"
                  role="status"
                >
                  The platform did not confirm whether this went out. Check the account before doing
                  anything: retrying blindly could post twice.
                  {canSchedule ? (
                    <Reconcile
                      busy={busy === post.id}
                      onSettle={(live, url) =>
                        void run(
                          post.id,
                          () => writeApi.reconcilePost(post.id, { live, url: url || undefined }),
                          live
                            ? 'Marked as published.'
                            : 'Marked as not published; you can retry it now.'
                        )
                      }
                    />
                  ) : null}
                </div>
              ) : null}
              {post.replies > 0 && post.status !== 'PUBLISHED' ? (
                <p className="text-xs text-muted-foreground">
                  A thread: this post and {post.replies} replies.
                </p>
              ) : null}
              {post.status === 'PUBLISHED' && post.threadProgress.quotes?.map((quote) => (
                <p key={quote.postId} className="text-xs text-muted-foreground" role="status">
                  Native quote on post {quote.postId}: {quote.state} when published.
                  {quote.state !== 'accepted' ? ' The post is live; check its Mastodon server for the current quote approval. Do not republish it to retry approval.' : ''}
                </p>
              ))}
              {stopped ? (
                <p
                  className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300"
                  role="status"
                >
                  {post.threadProgress.posted} of {post.threadProgress.total} replies went out.
                  {canSchedule ? (
                    <Button
                      disabled={busy === post.id}
                      onClick={() =>
                        void run(
                          post.id,
                          () => draftsApi.resumeThread(post.id),
                          'Posting the rest.'
                        )
                      }
                      size="sm"
                      variant="outline"
                    >
                      Post the rest
                    </Button>
                  ) : null}
                </p>
              ) : null}
              {post.status === 'PUBLISHED' ? (
                <div className="flex flex-wrap items-center gap-3 text-xs text-foreground/65">
                  {counts.length > 0 ? (
                    counts.map(([key, label]) => (
                      <span data-testid={`metric-${key}`} key={key}>
                        <span className="text-foreground">
                          {post.metrics?.[key]?.toLocaleString()}
                        </span>{' '}
                        {label}
                      </span>
                    ))
                  ) : (
                    <span>No engagement read yet.</span>
                  )}
                  <Button
                    variant="custom"
                    size={null}
                    className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                    disabled={busy === post.id}
                    onClick={() =>
                      void run(
                        post.id,
                        () => draftsApi.refreshMetrics(post.id),
                        'Engagement updated.'
                      )
                    }
                    type="button"
                  >
                    {post.metricsAt ? (
                      <>
                        Updated <LocalTime value={post.metricsAt} /> · Refresh
                      </>
                    ) : (
                      'Read engagement'
                    )}
                  </Button>
                </div>
              ) : null}
              {post.automations.length > 0 ? (
                <FollowUps
                  busy={busy === post.id}
                  onStop={
                    canSchedule &&
                    post.automations.some(
                      (item) => item.status === 'pending' && item.kind !== 'unretweet'
                    )
                      ? () =>
                          void run(
                            post.id,
                            () => writeApi.cancelAutomations(post.id),
                            'Follow-ups stopped. A repost already up is still removed on time.'
                          )
                      : undefined
                  }
                  post={post}
                />
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** What each follow-up is, as a person reads it. */
const FOLLOW_UP_LABELS: Record<DraftPostWire['automations'][number]['kind'], string> = {
  first_comment: 'First comment',
  plug: 'Auto-Plug reply',
  quote: 'Quote',
  repost_at_likes: 'Repost at likes',
  retweet: 'Auto-RT repost',
  unretweet: 'Remove the repost',
}

/** Where a follow-up is. */
const FOLLOW_UP_STATUS: Record<DraftPostWire['automations'][number]['status'], string> = {
  cancelled: 'stopped',
  done: 'done',
  expired: 'not reached in time',
  failed: 'failed',
  pending: 'waiting',
  skipped: 'skipped',
}

/** A live post's follow-ups and their receipts (RFC 025). */
function FollowUps({
  busy,
  onStop,
  post,
}: {
  busy: boolean
  onStop?: () => void
  post: DraftPostWire
}) {
  return (
    <div className="grid gap-1 text-xs" data-testid="follow-ups">
      <p className="flex items-center justify-between text-muted-foreground">
        After it went live
        {onStop ? (
          <Button disabled={busy} onClick={onStop} size="sm" variant="outline">
            Stop follow-ups
          </Button>
        ) : null}
      </p>
      <ul className="grid gap-0.5">
        {post.automations.map((item) => (
          <li
            className="flex items-center gap-2 text-muted-foreground"
            data-testid="follow-up"
            key={item.key}
          >
            <span className="text-foreground">{FOLLOW_UP_LABELS[item.kind]}</span>
            <LocalTime value={item.dueAt} />
            <span
              className={cn(
                item.status === 'failed' && 'text-red-700 dark:text-red-300',
                item.status === 'done' && 'text-emerald-700 dark:text-emerald-300'
              )}
            >
              {FOLLOW_UP_STATUS[item.status]}
              {item.failureCode && item.status !== 'done' ? ` (${item.failureCode})` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Say what the platform shows for a post of unknown outcome. Nothing is sent to it. */
function Reconcile({
  busy,
  onSettle,
}: {
  busy: boolean
  onSettle: (live: boolean, url: string) => void
}) {
  const [url, setUrl] = React.useState('')
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button disabled={busy} size="sm" variant="outline">
          I checked the account…
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid w-80 gap-2 p-3 text-sm">
        <p className="text-foreground">Is the post on the account?</p>
        <Input
          aria-label="The post's URL"
          onChange={(event) => setUrl(event.target.value)}
          placeholder="Its URL, if it is live (optional)"
          value={url}
        />
        <div className="flex gap-2">
          <Button onClick={() => onSettle(true, url.trim())} size="sm">
            It is live
          </Button>
          <Button onClick={() => onSettle(false, '')} size="sm" variant="outline">
            It is not there
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
