'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Pill } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { type DraftPostWire, draftsApi } from '@/lib/content-drafts/client'
import { writeApi } from '@/lib/write/client'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { DotsThreeIcon } from '@phosphor-icons/react/dist/ssr/DotsThree'
import { SidebarLink as Link } from '@/components/platform-shell/SidebarLink'
import { socialSetHref } from '@/components/workspace/settings-sections'
import {
  currentPosts,
  POST_STATE_TONE,
  postFailureFix,
  postFailureReason,
  postState,
  retryCanHelp,
} from '@/lib/content-drafts/post-status'
import { channelForPlatform } from '@/lib/content-drafts/serialize'
import type { DraftChannel } from '@/lib/write/document'
import { cn } from '@/lib/utils'
import { CHANNEL_META, ChannelIcon } from './channel-meta'
import { POST_COLUMN } from './layout'
import { LocalTime, WHEN_STYLE } from './local-time'
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
  fixFor,
  notAttempted = [],
  onCancel,
  onChange,
  onEdit,
  onReschedule,
  posts,
  zone,
}: {
  canSchedule: boolean
  /** Queued posts whose content the draft has changed since: they still send what was scheduled. */
  edited?: ReadonlySet<string>
  /** What the draft still needs for a platform, and where to fix it; null when nothing does. */
  fixFor?: (
    platform: string
  ) => { blocksRetry: boolean; label: string; open: () => void; problems: string[] } | null
  /** Destinations the draft targets that no post was ever made for. */
  notAttempted?: { channel: DraftChannel; id: string; label: string }[]
  /** The brand's zone, which every time here reads in. */
  zone?: string | null
  onCancel: (postId: string) => Promise<void>
  /** Open the reschedule review that replaces the queued posts with the current text. */
  onReschedule?: () => void
  /** Called with a post as the server now has it, or a new one. */
  onChange: (post: DraftPostWire) => void
  /** Open the editor on a failed post's platform, to fix its text, media or options. */
  onEdit?: (platform: string) => void
  posts: DraftPostWire[]
}) {
  const [busy, setBusy] = React.useState<string | null>(null)
  // The queued post whose Publish now confirmation is open, reached only through its menu.
  const [publishing, setPublishing] = React.useState<string | null>(null)
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
  // A failure a newer post of its destination replaced (a retry) folds away.
  const latest = currentPosts(posts)
  const earlier = posts.filter((post) => !latest.includes(post))
  // The brand's zone, else the one it was scheduled in if the brand is unknown here.
  const shownZone = (post: DraftPostWire) => zone ?? post.scheduleTimeZone
  // An earlier attempt is history: it shows what happened, with no action, so
  // it cannot be retried behind the post that replaced it.
  const row = (post: DraftPostWire, history = false) => {
          const channel = channelForPlatform(post.platform)
          const stopped =
            post.status === 'PUBLISHED' &&
            post.threadProgress.total > 0 &&
            post.threadProgress.posted < post.threadProgress.total
          const counts = METRICS.filter(([key]) => post.metrics?.[key] !== undefined)
          const state = postState(post.status, post.scheduledFor)
          const overdue = state === 'Overdue'
          const reason = postFailureReason(post.failureCode)
          const fix = postFailureFix(post.failureCode)
          const label = channel ? CHANNEL_META[channel].label : post.platform
          const support = `code ${post.failureCode} · post ${post.id} · ${post.platform}`
          const needed = history ? null : (fixFor?.(post.platform) ?? null)
          const sameFailures = earlier.filter(
            (attempt) =>
              attempt.channelConnectionId === post.channelConnectionId &&
              attempt.failureCode === post.failureCode
          ).length
          return (
            <li className="flex flex-col gap-2 px-4 py-3" data-testid="draft-post" key={post.id}>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm text-foreground">
                    {channel ? <ChannelIcon channel={channel} /> : null}
                    {label} ·{' '}
                    <LocalTime
                      options={
                        post.naturalOffsetSeconds ? { ...WHEN_STYLE, second: '2-digit' } : undefined
                      }
                      value={post.scheduledFor}
                      zone={shownZone(post)}
                    />
                    {post.naturalOffsetSeconds ? (
                      <span className="text-xs text-muted-foreground">
                        (natural time; slot{' '}
                        <LocalTime value={post.slotAt ?? post.scheduledFor} zone={shownZone(post)} />)
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
                      View on {label}
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
                            <LocalTime value={post.scheduledFor} zone={shownZone(post)} />. The
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
                  {/* Publish now is irreversible, so it never sits beside Cancel as a peer
                      button. The menu and its confirmation are siblings, as the library's
                      row menu does it, so closing the menu does not fight the dialog for
                      focus. */}
                  {canSchedule && post.status === 'SCHEDULED' ? (
                    <>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            aria-label={`More actions for the ${label} post`}
                            className="size-8"
                            disabled={busy !== null}
                            size={null}
                            variant="ghost"
                          >
                            <DotsThreeIcon aria-hidden className="size-4" weight="bold" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setPublishing(post.id)}>
                            Publish now…
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <AlertDialog
                        onOpenChange={(open) => !open && setPublishing(null)}
                        open={publishing === post.id}
                      >
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Publish this queued post now?</AlertDialogTitle>
                          <AlertDialogDescription>
                            It is queued for{' '}
                            <LocalTime value={post.scheduledFor} zone={shownZone(post)} />.
                            Publishing now sends the content saved when you scheduled this
                            destination and replaces that timer. Later draft edits are not
                            included. Approval and account access will be checked again.
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
                    </>
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
                  Confirmed live <LocalTime value={post.publishedAt} zone={shownZone(post)} />
                </p>
              ) : null}
              {post.status === 'PUBLISHED' && post.deletedAt ? (
                <p className="text-xs text-muted-foreground" role="status">
                  Deleted from {label} <LocalTime value={post.deletedAt} zone={shownZone(post)} />
                </p>
              ) : null}
              {post.deletions.length > 0 ? <DeleteParts post={post} /> : null}
              {canSchedule &&
              !history &&
              post.status === 'PUBLISHED' &&
              (!post.deletedAt || post.deletions.some((part) => part.status === 'failed')) ? (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      className="w-fit"
                      disabled={busy === post.id}
                      size="sm"
                      variant="outline"
                    >
                      Delete from {label}…
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete this post from {label}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Shots deletes the post, its thread parts and the replies Shots posted, and
                        undoes its reposts. This cannot be undone on {label}. Shots keeps its record
                        and a receipt for each part. A part that {label} cannot delete through its
                        API stays up and is marked not supported.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Keep it</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => {
                          setBusy(post.id)
                          void writeApi
                            .deletePost(post.id)
                            .then(() =>
                              toast.success(`Deleting from ${label}. Reload to see when it is done.`)
                            )
                            .catch((error: unknown) => toast.error(message(error)))
                            .finally(() => setBusy(null))
                        }}
                      >
                        Delete from {label}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : null}
              {post.status === 'CANCELLED' && reason ? (
                <p className="text-xs text-muted-foreground" role="status">
                  Cancelled before sending. {reason}
                </p>
              ) : null}
              {post.status === 'FAILED' ? (
                <div className="grid gap-1.5 text-xs text-red-700 dark:text-red-300" role="status">
                  <p>{reason ? `${reason} ` : ''}This destination did not publish.</p>
                  {needed ? (
                    <p data-testid="failure-needs">
                      {label} still needs this: {needed.problems.join(' ')}
                    </p>
                  ) : null}
                  {!history && sameFailures > 0 && retryCanHelp(post.failureCode) ? (
                    <p className="text-muted-foreground">
                      It failed the same way {sameFailures === 1 ? 'last time' : `${sameFailures} times before`},
                      and nothing has changed since, so it may fail again.
                    </p>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    {needed && fix !== 'reconnect' ? (
                      <Button onClick={needed.open} size="sm" variant="outline">
                        {needed.label}
                      </Button>
                    ) : null}
                    {!history && fix === 'reconnect' && post.socialSetId ? (
                      <Button asChild size="sm" variant="outline">
                        <Link href={socialSetHref(post.socialSetId)}>Reconnect the account</Link>
                      </Button>
                    ) : null}
                    {!history && (fix === 'edit' || fix === 'edit-media') && onEdit ? (
                      <Button onClick={() => onEdit(post.platform)} size="sm" variant="outline">
                        {fix === 'edit-media' ? `Replace the ${label} media` : `Edit the ${label} post`}
                      </Button>
                    ) : null}
                    {/* A retry resends what was scheduled, so it waits until it could work. */}
                    {!history && canSchedule && !needed?.blocksRetry && retryCanHelp(post.failureCode) ? (
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
                  </div>
                  {!history && (needed || !retryCanHelp(post.failureCode)) ? (
                    <p className="text-muted-foreground">
                      {needed?.blocksRetry
                        ? 'Fix this first: retrying now would fail the same way. Then schedule or publish the draft again.'
                        : retryCanHelp(post.failureCode)
                        ? 'A retry resends the version that was scheduled. To send your changes, schedule or publish the draft again.'
                        : 'Once it is fixed, schedule or publish the draft again: a retry would resend the old version.'}
                    </p>
                  ) : null}
                </div>
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
              {post.failureCode ? (
                // A popover, so opening it moves nothing under the pointer.
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      className="w-fit text-xs text-muted-foreground hover:text-foreground"
                      size={null}
                      variant="custom"
                    >
                      Details
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    className="grid w-80 gap-2 p-3 text-xs text-muted-foreground"
                    data-testid="failure-details"
                  >
                    <p className="font-mono break-all">{support}</p>
                    <Button
                      className="w-fit"
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(`${support} · ${post.scheduledFor}`)
                          .then(() => toast.success('Details copied for support.'))
                          .catch(() => toast.error('The details could not be copied.'))
                      }
                      size="sm"
                      variant="outline"
                    >
                      Copy for support
                    </Button>
                  </PopoverContent>
                </Popover>
              ) : null}
              {post.replies > 0 && post.status !== 'PUBLISHED' ? (
                <p className="text-xs text-muted-foreground">
                  A thread: this post and {post.replies} {post.replies === 1 ? 'reply' : 'replies'}.
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
                  {post.threadProgress.posted} of {post.threadProgress.total}{' '}
                  {post.threadProgress.total === 1 ? 'reply' : 'replies'} went out.
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
                        Updated <LocalTime value={post.metricsAt} zone={shownZone(post)} /> · Refresh
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
                  zone={shownZone(post)}
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
  }
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
        {latest.map((post) => row(post))}
        {notAttempted.map((destination) => (
          <li
            className="flex flex-col gap-1 px-4 py-3"
            data-testid="draft-post-not-attempted"
            key={destination.id}
          >
            <div className="flex items-center justify-between gap-4">
              <p className="flex items-center gap-1.5 text-sm text-foreground">
                <ChannelIcon channel={destination.channel} />
                {destination.label}
              </p>
              <Pill tone="gray">Not attempted</Pill>
            </div>
            <p className="text-xs text-muted-foreground">
              This platform was not part of the last send, so nothing went out here. A failure on
              another platform does not skip it. Schedule or publish the draft to send it.
            </p>
          </li>
        ))}
      </ul>
      {earlier.length > 0 ? (
        <Disclosure className="mt-2 text-xs text-muted-foreground" data-testid="earlier-attempts">
          <DisclosureTrigger className="select-none hover:text-foreground">
            {earlier.length} earlier attempt{earlier.length === 1 ? '' : 's'}
          </DisclosureTrigger>
          <DisclosureContent>
            <ul className="mt-2 divide-y divide-foreground/[0.05] rounded-xl border border-foreground/[0.06]">
              {earlier.map((post) => row(post, true))}
            </ul>
          </DisclosureContent>
        </Disclosure>
      ) : null}
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
  thumbnail: 'Custom thumbnail',
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

/** Where a part of a delete is. */
const DELETE_PART_STATUS: Record<DraftPostWire['deletions'][number]['status'], string> = {
  done: 'deleted',
  failed: 'failed',
  pending: 'waiting',
  unsupported: 'not supported',
}

/** What a delete part is, from its key: the root, a thread part, a repost or a reply. */
function deletePartLabel(key: string): string {
  if (key === 'root') return 'Post'
  if (key.startsWith('thread:')) return 'Thread part'
  if (key.startsWith('repost:')) return 'Repost'
  return 'Reply'
}

/** The parts of a delete from the platform and their receipts. */
function DeleteParts({ post }: { post: DraftPostWire }) {
  return (
    <ul className="grid gap-0.5 text-xs text-muted-foreground" data-testid="delete-parts">
      {post.deletions.map((part) => (
        <li className="flex items-center gap-2" key={part.key}>
          <span className="text-foreground">{deletePartLabel(part.key)}</span>
          <span
            className={cn(
              part.status === 'failed' && 'text-red-700 dark:text-red-300',
              part.status === 'done' && 'text-emerald-700 dark:text-emerald-300'
            )}
          >
            {DELETE_PART_STATUS[part.status]}
            {part.failureCode && part.status !== 'done' ? ` (${part.failureCode})` : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** A live post's follow-ups and their receipts (RFC 025). */
function FollowUps({
  busy,
  onStop,
  post,
  zone,
}: {
  busy: boolean
  onStop?: () => void
  post: DraftPostWire
  zone?: string | null
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
            <LocalTime value={item.dueAt} zone={zone} />
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
