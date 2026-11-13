'use client'

import type { BackendCampaignPost } from 'screenshot-studio-backend-sdk'
import type { CampaignPostStatus } from '@/lib/tenant/campaign-status'
import * as Tabs from '@radix-ui/react-tabs'
import { CopyIcon as Copy01Icon } from '@phosphor-icons/react/dist/ssr/Copy'
import { PencilIcon as Edit02Icon } from '@phosphor-icons/react/dist/ssr/Pencil'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import { RevisePanel } from '@/components/launch/RevisePanel'
import { CampaignLocalTime as LocalTime } from '@/components/campaigns/CampaignLocalTime'
import { Pill, type PillTone } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { getErrorMessage } from '@/components/workspace/settings-client'
import { campaignPostReviewIssue, CHANNEL_RULES } from '@/lib/launch/guards'
import { postEditBlock } from '@/lib/launch/post-edit'
import { connectionsForChannel } from '@/lib/launch/schedule'
import type { LaunchChannel } from '@/lib/launch/spec-schema'
import {
  type CampaignApprovalDecision,
  canTransitionCampaignPost,
} from '@/lib/tenant/campaign-status'
import { useTRPCClient } from '@/lib/trpc/react'
import { cn } from '@/lib/utils'
import { PostLinkCheck } from '@/components/link-preview/PostLinkCheck'
import { LengthCounter, PostEditor } from './PostEditor'
import { CancelScheduleButton, ScheduleDialog, type ScheduleVisual } from './ScheduleDialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'

export type CopyPost = {
  /** "G1 · Upgrade with one command", from the plan. */
  angle: string | null
  /** Who approved the post and when; `by` is null once the approver left the workspace. */
  approval: { at: string; by: string | null } | null
  callToAction: string | null
  channel: string
  /** Spec claims the post relies on; `current` is false once the working spec says something else there. */
  claims: { current: boolean; ref: string; text: string }[]
  copy: string
  /** The visual already attached to the post, from an earlier schedule. */
  creativeVariantId: string | null
  /** Written for an earlier plan version than the one the campaign works from now. */
  fromEarlierPlan: boolean
  id: string
  /** "Teaser", "Launch day", or "Follow-up". */
  phase: string | null
  reviewNote: string | null
  scheduledAt: string | null
  scheduledPostId: string | null
  /** Delivery state of the scheduled post; CANCELLED or FAILED can be rescheduled. */
  scheduledPostStatus: ScheduledPostStatus | null
  status: CampaignPostStatus
  title: string | null
  /** Approved visuals the post can publish with, best match first. */
  visuals: ScheduleVisual[]
}

type ScheduledPostStatus = NonNullable<BackendCampaignPost['scheduledPostStatus']>

export type CopyChannel = { label: string; role: string | null; value: string }

type Permissions = {
  aiConfigured: boolean
  campaignId: string
  canApprove: boolean
  canEdit: boolean
  /** publish:manage: schedule, reschedule, and cancel posts. */
  canSchedule: boolean
}

const DELIVERY: Record<ScheduledPostStatus, string> = {
  CANCELLED: 'Cancelled',
  DRAFT: 'Queued',
  FAILED: 'Failed to publish',
  PROCESSING: 'Publishing now',
  PUBLISHED: 'Published',
  SCHEDULED: 'Scheduled',
  UNKNOWN_DELIVERY: 'Delivery unknown; check the channel',
  SENT_TO_APP: 'Sent to the app to finish there',
}

/** Scheduled posts still waiting to publish; only these can be cancelled. */
const LIVE_DELIVERY: readonly ScheduledPostStatus[] = ['DRAFT', 'SCHEDULED']
/** Scheduled posts that never reached the channel; these can be scheduled again. */
const DEAD_DELIVERY: readonly ScheduledPostStatus[] = ['CANCELLED', 'FAILED']

const POST_STATUS: Record<CampaignPostStatus, { label: string; tone: PillTone }> = {
  APPROVED: { label: 'Approved', tone: 'green' },
  DRAFT: { label: 'Draft', tone: 'gray' },
  NEEDS_CHANGES: { label: 'Changes requested', tone: 'yellow' },
  PUBLISHED: { label: 'Published', tone: 'green' },
  READY_FOR_REVIEW: { label: 'In review', tone: 'yellow' },
  REJECTED: { label: 'Rejected', tone: 'red' },
  SCHEDULED: { label: 'Scheduled', tone: 'blue' },
}

const DECISIONS: {
  decision: CampaignApprovalDecision
  label: string
  needsNote: boolean
  variant: 'default' | 'outline'
}[] = [
  { decision: 'submit', label: 'Submit for review', needsNote: false, variant: 'outline' },
  { decision: 'approve', label: 'Approve', needsNote: false, variant: 'default' },
  { decision: 'request_changes', label: 'Request changes', needsNote: true, variant: 'outline' },
  { decision: 'reject', label: 'Reject', needsNote: true, variant: 'outline' },
]

/** The review moves valid for the post's status and the reviewer's role; the server re-checks. */
function ReviewActions({ permissions, post }: { permissions: Permissions; post: CopyPost }) {
  const trpcClient = useTRPCClient()
  const router = useRouter()
  const noteId = useId()
  const [noting, setNoting] = useState<CampaignApprovalDecision | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reviewIssue = campaignPostReviewIssue(post)
  const available = DECISIONS.filter(
    ({ decision }) =>
      canTransitionCampaignPost(decision, post.status) &&
      (decision === 'submit' ? permissions.canEdit : permissions.canApprove)
  )

  async function decide(decision: CampaignApprovalDecision, reviewNote?: string) {
    setBusy(true)
    setError(null)
    try {
      await trpcClient.campaign.decideApproval.mutate({
        campaignId: permissions.campaignId,
        decision,
        postIds: [post.id],
        ...(reviewNote ? { note: reviewNote } : {}),
      })
      setNoting(null)
      setNote('')
      router.refresh()
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    } finally {
      setBusy(false)
    }
  }

  const alert = error ? (
    <div
      className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
      role="alert"
    >
      {error}
    </div>
  ) : null

  if (noting) {
    return (
      <>
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (noting !== 'request_changes' || note.trim()) void decide(noting, note.trim())
          }}
        >
          <div className="flex items-baseline justify-between gap-3">
            <Label className="text-xs font-medium text-foreground/65" htmlFor={noteId}>
              Review note
            </Label>
            <span className="text-xs text-muted-foreground">
              {noting === 'reject' ? 'Rejecting this post' : 'Requesting changes'}
            </span>
          </div>
          <Textarea
            autoFocus
            className="min-h-20 w-full rounded-lg border border-foreground/[0.08] bg-foreground/[0.03] px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground/75 focus:border-foreground/20"
            id={noteId}
            maxLength={1_000}
            onChange={(event) => setNote(event.target.value)}
            placeholder={
              noting === 'reject'
                ? 'Why does this not work? The next draft learns from it.'
                : 'What should change? The next draft follows this note.'
            }
            value={note}
          />
          <div className="flex justify-end gap-2">
            <Button
              className="rounded-lg"
              disabled={busy}
              onClick={() => setNoting(null)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              className="rounded-lg"
              disabled={busy || (noting === 'request_changes' && !note.trim())}
              size="sm"
              type="submit"
            >
              {busy ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </form>
        {alert}
      </>
    )
  }

  return (
    <>
      {available.map(({ decision, label, needsNote, variant }) => (
        <Button
          className="h-8 rounded-lg text-xs"
          disabled={
            busy || (Boolean(reviewIssue) && (decision === 'submit' || decision === 'approve'))
          }
          title={reviewIssue ?? undefined}
          key={decision}
          onClick={() => (needsNote ? setNoting(decision) : void decide(decision))}
          size="sm"
          type="button"
          variant={variant}
        >
          {label}
        </Button>
      ))}
      {alert}
    </>
  )
}

function CopyTextButton({ post }: { post: CopyPost }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(
        [post.title, post.copy, post.callToAction].filter(Boolean).join('\n\n')
      )
      toast.success('Copied to the clipboard')
    } catch {
      toast.error('Could not copy. Select the text and copy it instead.')
    }
  }
  return (
    <Button
      className="ml-auto h-8 gap-1.5 rounded-lg text-xs"
      onClick={() => void copy()}
      size="sm"
      type="button"
      variant="ghost"
    >
      <Copy01Icon size={14} />
      Copy text
    </Button>
  )
}

/** Sends every draft and every post sent back to review at once, across channels. */
function SubmitAll({ permissions, posts }: { permissions: Permissions; posts: CopyPost[] }) {
  const trpcClient = useTRPCClient()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const eligible = posts.filter((post) => canTransitionCampaignPost('submit', post.status))
  const count = eligible.length
  const blocked = eligible.some((post) => campaignPostReviewIssue(post))
  if (!permissions.canEdit || count === 0) return null

  async function submitAll() {
    setBusy(true)
    try {
      await trpcClient.campaign.decideApproval.mutate({
        campaignId: permissions.campaignId,
        decision: 'submit',
      })
      toast.success(`${count} ${count === 1 ? 'post' : 'posts'} sent for review`)
      router.refresh()
    } catch (requestError) {
      toast.error('The posts could not be sent for review', {
        description: getErrorMessage(requestError),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      className="rounded-lg"
      disabled={busy || blocked}
      title={blocked ? 'Shorten the flagged posts before submitting all.' : undefined}
      onClick={() => void submitAll()}
      size="sm"
      type="button"
      variant="outline"
    >
      {busy ? 'Submitting…' : `Submit all ${count} for review`}
    </Button>
  )
}

/** Approves the given posts in one decision; the server re-checks each one is in review. */
function ApprovePosts({
  label,
  onDone,
  permissions,
  postIds,
  blocked = false,
}: {
  label: string
  onDone?: () => void
  permissions: Permissions
  postIds: string[]
  blocked?: boolean
}) {
  const trpcClient = useTRPCClient()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  if (!permissions.canApprove || postIds.length === 0) return null

  async function approve() {
    setBusy(true)
    try {
      await trpcClient.campaign.decideApproval.mutate({
        campaignId: permissions.campaignId,
        decision: 'approve',
        postIds,
      })
      toast.success(`${postIds.length} ${postIds.length === 1 ? 'post' : 'posts'} approved`)
      onDone?.()
      router.refresh()
    } catch (requestError) {
      toast.error('The posts could not be approved', {
        description: getErrorMessage(requestError),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      className="rounded-lg"
      disabled={busy || blocked}
      title={blocked ? 'Shorten the flagged posts before approving.' : undefined}
      onClick={() => void approve()}
      size="sm"
      type="button"
    >
      {busy ? 'Approving…' : label}
    </Button>
  )
}

/** Schedule, reschedule, or cancel, depending on where the post is in publishing. */
function ScheduleActions({
  channelLabel,
  permissions,
  post,
}: {
  channelLabel: string
  permissions: Permissions
  post: CopyPost
}) {
  if (!permissions.canSchedule || campaignPostReviewIssue(post)) return null
  const live =
    post.status === 'SCHEDULED' &&
    post.scheduledPostId !== null &&
    post.scheduledPostStatus !== null &&
    LIVE_DELIVERY.includes(post.scheduledPostStatus)
  if (live && post.scheduledPostId) {
    return <CancelScheduleButton scheduledPostId={post.scheduledPostId} />
  }
  const reschedule =
    post.status === 'SCHEDULED' &&
    post.scheduledPostStatus !== null &&
    DEAD_DELIVERY.includes(post.scheduledPostStatus)
  if (post.status !== 'APPROVED' && !reschedule) return null
  if (connectionsForChannel(post.channel, []) === null) {
    return <span className="text-xs text-muted-foreground">Can&apos;t be scheduled yet</span>
  }
  return (
    <ScheduleDialog
      campaignId={permissions.campaignId}
      channelLabel={channelLabel}
      post={post}
      reschedule={reschedule}
    />
  )
}

/**
 * Delivery readiness, kept apart from review: an approved post can still be
 * blocked. The channel connection itself is checked when scheduling.
 */
function schedulingState(post: CopyPost): { label: string; tone: PillTone } {
  if (post.status === 'SCHEDULED' || post.status === 'PUBLISHED') return POST_STATUS[post.status]
  if (post.status !== 'APPROVED') return { label: 'Waiting for approval', tone: 'gray' }
  if (campaignPostReviewIssue(post)) return { label: 'Blocked by review', tone: 'red' }
  if (connectionsForChannel(post.channel, []) === null)
    return { label: 'No scheduling channel', tone: 'gray' }
  if (post.visuals.length === 0) return { label: 'Ready without a visual', tone: 'yellow' }
  return { label: 'Ready for a connected channel', tone: 'green' }
}

function PostCard({
  channelLabel,
  onSelect,
  permissions,
  post,
  selected,
}: {
  channelLabel: string
  onSelect: (selected: boolean) => void
  permissions: Permissions
  post: CopyPost
  selected: boolean
}) {
  const status = POST_STATUS[post.status]
  const scheduling = schedulingState(post)
  // An approval record outlives a return to review; only these states still rest on it.
  const approvedRevision =
    post.approval !== null &&
    (post.status === 'APPROVED' || post.status === 'SCHEDULED' || post.status === 'PUBLISHED')
  const [editing, setEditing] = useState(false)
  const editBlock = postEditBlock(
    post.status,
    post.scheduledPostStatus !== null && DEAD_DELIVERY.includes(post.scheduledPostStatus)
  )
  const limit = Object.hasOwn(CHANNEL_RULES, post.channel)
    ? CHANNEL_RULES[post.channel as LaunchChannel].bodyMax
    : null
  const selectable = permissions.canApprove && post.status === 'READY_FOR_REVIEW'
  return (
    <article
      id={`post-${post.id}`}
      className="scroll-mt-6 flex flex-col rounded-2xl bg-foreground/[0.015] ring-1 ring-foreground/[0.08]"
    >
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center gap-1.5">
          {selectable ? (
            <Checkbox
              aria-label={`Select ${post.title ?? `${channelLabel} post`} for approval`}
              checked={selected}
              className="mr-1 size-4 accent-white"
              onCheckedChange={(checked) => onSelect(checked === true)}
            />
          ) : null}
          {post.phase ? <Pill>{post.phase}</Pill> : null}
          {post.angle ? <Pill tone="blue">{post.angle}</Pill> : null}
          {post.fromEarlierPlan ? <Pill>From an earlier plan</Pill> : null}
          <span className="ml-auto flex flex-wrap gap-1.5">
            <Pill tone={approvedRevision ? 'green' : status.tone}>
              Review:{' '}
              {approvedRevision
                ? 'Approved revision'
                : post.status === 'SCHEDULED' || post.status === 'PUBLISHED'
                  ? 'See approval history'
                  : status.label}
            </Pill>
            <Pill tone={scheduling.tone}>Scheduling: {scheduling.label}</Pill>
          </span>
        </div>
        {editing ? (
          <PostEditor
            campaignId={permissions.campaignId}
            limit={limit}
            onDone={() => setEditing(false)}
            post={post}
          />
        ) : (
          <>
            {post.title ? (
              <h3 className="text-base font-medium text-balance text-foreground">{post.title}</h3>
            ) : null}
            <p className="text-sm leading-6 whitespace-pre-wrap text-foreground">{post.copy}</p>
            <PostLinkCheck text={post.copy} />
            {post.callToAction || limit ? (
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                {post.callToAction ? (
                  <p className="text-sm text-foreground">
                    <span className="mr-2 text-xs font-medium text-muted-foreground">
                      Call to action
                    </span>
                    {post.callToAction}
                  </p>
                ) : null}
                {limit ? (
                  <LengthCounter callToAction={post.callToAction} copy={post.copy} limit={limit} />
                ) : null}
              </div>
            ) : null}
          </>
        )}
        {campaignPostReviewIssue(post) ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-300">
            {campaignPostReviewIssue(post)}
          </p>
        ) : null}
        {post.visuals.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Visuals: {post.visuals.map((visual) => visual.label).join(', ')}
          </p>
        ) : (
          <p className="text-xs text-amber-700 dark:text-amber-300">
            No approved visual yet. Review the campaign assets before scheduling.
          </p>
        )}
        {post.approval || post.scheduledAt ? (
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            {post.approval ? (
              <p>
                Approved{post.approval.by ? ` by ${post.approval.by}` : ''} ·{' '}
                <LocalTime value={post.approval.at} />
              </p>
            ) : null}
            {post.status === 'SCHEDULED' && post.scheduledAt ? (
              <p>
                Scheduled for <LocalTime value={post.scheduledAt} />
                {post.scheduledPostStatus ? ` · ${DELIVERY[post.scheduledPostStatus]}` : ''}
              </p>
            ) : null}
          </div>
        ) : null}
        {post.reviewNote ? (
          <div className="rounded-xl bg-amber-500/[0.06] px-4 py-3 ring-1 ring-amber-500/20">
            <p className="text-xs font-medium text-amber-700 dark:text-amber-300">Reviewer note</p>
            <p className="mt-1 text-sm whitespace-pre-wrap text-foreground">{post.reviewNote}</p>
          </div>
        ) : null}
        {post.claims.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">Based on</p>
            <ul className="flex flex-wrap gap-1.5">
              {post.claims.map((claim, index) => (
                <li
                  className={cn(
                    'flex max-w-full flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg px-2.5 py-1.5 text-xs ring-1',
                    claim.current
                      ? 'bg-foreground/[0.03] ring-foreground/[0.06]'
                      : 'bg-amber-500/[0.04] ring-amber-500/20'
                  )}
                  key={`${claim.ref}-${index}`}
                >
                  <code className="font-mono text-foreground/65">{claim.ref}</code>
                  <span className="text-foreground/80">{claim.text}</span>
                  {claim.current ? null : <Pill tone="yellow">Changed in the current spec</Pill>}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      {/* Open forms and panels are divs and forms, and take the full row. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-foreground/[0.06] px-5 py-3 [&>div]:basis-full [&>form]:basis-full">
        <ReviewActions
          permissions={
            editing ? { ...permissions, canEdit: false, canApprove: false } : permissions
          }
          post={post}
        />
        <ScheduleActions
          channelLabel={channelLabel}
          permissions={editing ? { ...permissions, canSchedule: false } : permissions}
          post={post}
        />
        {permissions.canEdit && !editing ? (
          editBlock ? (
            <span className="text-xs text-muted-foreground">{editBlock}</span>
          ) : (
            <Button
              className="h-8 gap-1.5 rounded-lg text-xs"
              onClick={() => setEditing(true)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Edit02Icon size={14} />
              Edit
            </Button>
          )
        ) : null}
        <CopyTextButton post={post} />
        {permissions.canEdit ? (
          <RevisePanel
            campaignId={permissions.campaignId}
            disabled={!permissions.aiConfigured}
            target={{ postId: post.id, type: 'post' }}
          />
        ) : null}
      </div>
    </article>
  )
}

/**
 * Posts by channel, each with its provenance (the spec claims it relies on)
 * and the review moves for its status. Inactive panels stay mounted so a
 * half-written note or revision survives switching channels.
 */
export function CopyBoard({
  channels,
  permissions,
  posts,
}: {
  channels: CopyChannel[]
  permissions: Permissions
  posts: CopyPost[]
}) {
  const requestedChannel = useSearchParams().get('channel')
  const initial =
    channels.find((channel) => channel.value === requestedChannel) ??
    channels.find((channel) => posts.some((post) => post.channel === channel.value)) ??
    channels[0]
  const [activeChannel, setActiveChannel] = useState(initial?.value)
  const requestedValue = channels.find((channel) => channel.value === requestedChannel)?.value
  useEffect(() => {
    if (!requestedValue) return
    setActiveChannel(requestedValue)
    requestAnimationFrame(() => {
      const target = document.getElementById(window.location.hash.slice(1))
      target?.scrollIntoView({ block: 'nearest' })
    })
  }, [requestedChannel, requestedValue])
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const inReview = posts.filter((post) => post.status === 'READY_FOR_REVIEW').map((post) => post.id)
  // A post that left review since it was ticked is no longer selectable.
  const selectedIds = inReview.filter((id) => selected.has(id))
  return (
    <Tabs.Root
      className="flex flex-col gap-5"
      value={activeChannel}
      onValueChange={setActiveChannel}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs.List
          aria-label="Channels"
          className="flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-lg bg-foreground/[0.03] p-0.5 ring-1 ring-foreground/[0.08]"
        >
          {channels.map((channel) => (
            <Tabs.Trigger
              className="flex shrink-0 items-center gap-2 rounded-md px-3 py-1 text-ui-lg font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/30 data-[state=active]:bg-foreground/[0.08] data-[state=active]:text-foreground"
              key={channel.value}
              value={channel.value}
            >
              {channel.label}{' '}
              <span className="text-xs text-muted-foreground tabular-nums">
                {posts.filter((post) => post.channel === channel.value).length}
              </span>
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <div className="flex flex-wrap items-center gap-2">
          <SubmitAll permissions={permissions} posts={posts} />
          {selectedIds.length > 0 ? (
            <ApprovePosts
              label={`Approve ${selectedIds.length} selected`}
              onDone={() => setSelected(new Set())}
              permissions={permissions}
              postIds={selectedIds}
              blocked={posts.some(
                (post) => selectedIds.includes(post.id) && campaignPostReviewIssue(post) !== null
              )}
            />
          ) : (
            <ApprovePosts
              label={`Approve all ${inReview.length}`}
              permissions={permissions}
              postIds={inReview}
              blocked={posts.some(
                (post) => inReview.includes(post.id) && campaignPostReviewIssue(post) !== null
              )}
            />
          )}
        </div>
      </div>
      {channels.map((channel) => {
        const channelPosts = posts.filter((post) => post.channel === channel.value)
        return (
          <Tabs.Content
            className="flex flex-col gap-4 outline-none data-[state=inactive]:hidden"
            forceMount
            key={channel.value}
            value={channel.value}
          >
            {channel.role ? <p className="text-sm text-muted-foreground">{channel.role}</p> : null}
            {channelPosts.length === 0 ? (
              <p className="rounded-2xl bg-foreground/[0.015] px-6 py-10 text-center text-sm text-muted-foreground ring-1 ring-foreground/[0.06]">
                No {channel.label} posts yet.
              </p>
            ) : (
              channelPosts.map((post) => (
                <PostCard
                  channelLabel={channel.label}
                  key={post.id}
                  onSelect={(checked) =>
                    setSelected((current) => {
                      const next = new Set(current)
                      if (checked) next.add(post.id)
                      else next.delete(post.id)
                      return next
                    })
                  }
                  permissions={permissions}
                  post={post}
                  selected={selected.has(post.id)}
                />
              ))
            )}
          </Tabs.Content>
        )
      })}
    </Tabs.Root>
  )
}
