'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { DatePicker } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { TimePicker } from '@/components/ui/time-picker'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { type DraftPostWire, draftsApi } from '@/lib/content-drafts/client'
import { currentPosts, retryCanHelp } from '@/lib/content-drafts/post-status'
import { platformLabel } from '@/lib/content-drafts/serialize'
import { writeApi } from '@/lib/write/client'
import {
  evenTimes,
  type QueueRow,
  type QueueWarning,
  shiftedTimes,
  spacedTimes,
} from '@/lib/write/queue-actions'
import { resolveLocalTime, wallTime } from '@/lib/write/zoned-time'

/** How far a selection moves in one step, as the bar offers it. */
const STEPS = [
  { label: '15 minutes', minutes: 15 },
  { label: '1 hour', minutes: 60 },
  { label: '3 hours', minutes: 180 },
  { label: '1 day', minutes: 1_440 },
  { label: '1 week', minutes: 10_080 },
] as const

/**
 * Acting on several queued posts at once. Editing a sequence means moving
 * everything later, spacing it evenly, or taking it back to drafts — none of
 * which is possible one post at a time without losing the shape of the run.
 *
 * Each change is committed through the post's own move, so the backend keeps
 * refusing what a queued commitment may not do. A post that refuses is
 * reported; the rest still move.
 */
export function QueueBulkBar({
  onDone,
  rows,
  zone,
}: {
  /** Reload the queue and clear the selection. */
  onDone: () => void
  /** The selected rows, all of them scheduled posts. */
  rows: QueueRow[]
  zone: string
}) {
  const [step, setStep] = React.useState(60)
  const [gap, setGap] = React.useState(60)
  const [busy, setBusy] = React.useState(false)
  const first = rows.length
    ? new Date(Math.min(...rows.map((row) => new Date(row.at).getTime())))
    : null
  const last = rows.length
    ? new Date(Math.max(...rows.map((row) => new Date(row.at).getTime())))
    : null
  // The end of the range follows where the run already ends, so "spread
  // evenly" is a one-press change of shape; once it is set by hand it stays,
  // and it keeps following the selection as more posts are picked.
  const [edited, setEdited] = React.useState<{ day: string; time: string } | null>(null)
  const end = wallTime(last ?? new Date(), zone)
  const until = edited ?? { day: end.slice(0, 10), time: end.slice(11, 16) }
  const setUntil = (next: { day: string; time: string }) => setEdited(next)
  const apply = async (times: Map<string, Date>, done: string) => {
    // A queued post cannot move into the past, and a half-applied move would
    // leave the run in a shape nobody asked for: check the whole change first.
    const past = [...times.values()].filter((at) => at.getTime() <= Date.now()).length
    if (past) {
      toast.error(
        past === times.size
          ? 'That would put every selected post in the past.'
          : `That would put ${past} of them in the past. Nothing was moved.`
      )
      return
    }
    setBusy(true)
    let failed = 0
    // One at a time, and in the direction of travel, so two posts never pass
    // through the same time. A refusal must not stop the rest from moving.
    const ordered = [...times.entries()].sort(([, a], [, b]) => a.getTime() - b.getTime())
    const movingLater = ordered.some(
      ([id, at]) => at.getTime() > new Date(rows.find((row) => row.id === id)?.at ?? 0).getTime()
    )
    for (const [id, at] of movingLater ? ordered.reverse() : ordered) {
      try {
        await draftsApi.movePost(id, at)
      } catch {
        failed += 1
      }
    }
    setBusy(false)
    if (failed) toast.error(`${failed} of ${times.size} posts did not move.`)
    else toast.success(done)
    onDone()
  }
  const sendBack = async () => {
    setBusy(true)
    let failed = 0
    for (const row of rows) {
      try {
        const draft = await draftsApi.get(row.draftId)
        await writeApi.unschedule({
          at: null,
          calendarVersion: draft.calendarVersion,
          draftId: draft.id,
          postId: row.id,
          timeZone: zone,
          version: draft.version,
        })
      } catch {
        failed += 1
      }
    }
    setBusy(false)
    if (failed) toast.error(`${failed} of ${rows.length} posts stayed queued.`)
    else
      toast.success(
        `${rows.length} ${rows.length === 1 ? 'post is' : 'posts are'} back in drafts, keeping their time as a plan.`
      )
    onDone()
  }
  return (
    <div
      aria-busy={busy}
      aria-label="Selected queued posts"
      className="mx-3 mt-2 grid gap-2 rounded-lg border border-sky-400/30 bg-sky-400/[0.05] px-2 py-2 text-xs"
      data-testid="queue-bulk-bar"
      role="toolbar"
    >
      <div className="flex flex-wrap items-center gap-1">
        <span className="mr-auto text-sky-700 dark:text-sky-200">
          {rows.length} selected
        </span>
        <Button onClick={onDone} size="sm" variant="ghost">
          Clear
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Select onValueChange={(value) => setStep(Number(value))} value={String(step)}>
          <SelectTrigger aria-label="Move by" className="h-7 w-32 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STEPS.map((option) => (
              <SelectItem key={option.minutes} value={String(option.minutes)}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          disabled={busy}
          onClick={() => void apply(shiftedTimes(rows, -step), 'Moved earlier.')}
          size="sm"
          variant="ghost"
        >
          Earlier
        </Button>
        <Button
          disabled={busy}
          onClick={() => void apply(shiftedTimes(rows, step), 'Moved later.')}
          size="sm"
          variant="ghost"
        >
          Later
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Label className="flex items-center gap-1 font-normal text-muted-foreground">
          Every
          <Input
            aria-label="Minutes between posts"
            className="h-7 w-16 text-xs"
            max={1440}
            min={1}
            onChange={(event) => setGap(Math.min(1440, Math.max(1, Number(event.target.value) || 1)))}
            type="number"
            value={gap}
          />
          min
        </Label>
        <Button
          disabled={busy || !first || rows.length < 2}
          onClick={() =>
            first && void apply(spacedTimes(rows, first, gap), 'Spaced evenly.')
          }
          size="sm"
          variant="ghost"
        >
          Space from the first
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-1">
        <Label className="grid gap-1 font-normal text-muted-foreground">
          Spread until
          <DatePicker
            aria-label="Spread until day"
            onChange={(value) => setUntil({ ...until, day: value })}
            value={until.day}
          />
        </Label>
        <TimePicker
          aria-label="Spread until time"
          onChange={(value) => setUntil({ ...until, time: value })}
          value={until.time}
        />
        <Button
          disabled={busy || !first || rows.length < 2}
          onClick={() => {
            const end = resolveLocalTime(`${until.day}T${until.time}`, zone)
            if (!first || end.kind !== 'exact' || end.at <= first)
              return toast.error('Choose an end after the first selected post.')
            void apply(evenTimes(rows, first, end.at), 'Spread evenly over the range.')
          }}
          size="sm"
          variant="ghost"
        >
          Spread evenly
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {/* Changing where a post goes means rebuilding its commitment, so the
            honest route is back to the draft, where its platforms are set. */}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button disabled={busy} size="sm" variant="ghost">
              Send back to drafts
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Take {rows.length} {rows.length === 1 ? 'post' : 'posts'} out of the queue?
              </AlertDialogTitle>
              <AlertDialogDescription>
                They stop publishing by themselves and keep their time as a plan on the calendar,
                so you can change their text or platforms and schedule them again.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep them queued</AlertDialogCancel>
              <AlertDialogAction onClick={() => void sendBack()}>
                Send back to drafts
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  )
}

/**
 * A draft's posts, read on demand: where each one went live, and a retry for
 * each failure. The library list carries counts, not posts, so nothing is
 * fetched until someone asks about a particular draft — which is the moment
 * "a link to the live post" is actually wanted.
 */
export function DraftPostLinks({ draftId }: { draftId: string }) {
  const [posts, setPosts] = React.useState<DraftPostWire[] | null>(null)
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    let live = true
    draftsApi.posts(draftId).then(
      (result) => live && setPosts(result.posts),
      (cause: unknown) =>
        live && setError(cause instanceof Error ? cause.message : 'Could not read its posts.')
    )
    return () => {
      live = false
    }
  }, [draftId])
  if (error)
    return (
      <p className="px-4 pb-2 text-[11px] text-red-700 dark:text-red-300" role="alert">
        {error}
      </p>
    )
  if (!posts)
    return (
      <p className="px-4 pb-2 text-[11px] text-muted-foreground" role="status">
        Reading its posts…
      </p>
    )
  const live = posts.filter((post) => post.url)
  if (!live.length)
    return (
      <p className="px-4 pb-2 text-[11px] text-muted-foreground">
        No link yet: the platform has not reported one.
      </p>
    )
  return (
    <ul className="grid gap-0.5 px-4 pb-2" data-testid="draft-post-links">
      {live.map((post) => (
        <li key={post.id}>
          <a
            className="text-[11px] text-sky-700 underline dark:text-sky-300"
            href={post.url ?? '#'}
            rel="noreferrer"
            target="_blank"
          >
            Open the {platformLabel(post.platform)} post
          </a>
        </li>
      ))}
    </ul>
  )
}

/**
 * Retry every failure in the listed drafts whose code says a retry could
 * work. Each retry resends the version that was scheduled; a failure that
 * needs a fix first (a disconnected account, a refused option) is counted
 * and left alone rather than resent to fail the same way.
 */
export function RetryAllFailed({ draftIds }: { draftIds: string[] }) {
  const [busy, setBusy] = React.useState(false)
  const run = async () => {
    setBusy(true)
    let sent = 0
    let skipped = 0
    let failed = 0
    for (const draftId of draftIds) {
      try {
        const { posts } = await draftsApi.posts(draftId)
        for (const post of currentPosts(posts)) {
          if (post.status !== 'FAILED') continue
          if (!retryCanHelp(post.failureCode)) {
            skipped += 1
            continue
          }
          try {
            await writeApi.retryPost(post.id)
            sent += 1
          } catch {
            failed += 1
          }
        }
      } catch {
        failed += 1
      }
    }
    setBusy(false)
    const left = [
      skipped ? `${skipped} need a fix first` : '',
      failed ? `${failed} could not be retried` : '',
    ].filter(Boolean)
    if (sent)
      toast.success(
        `Retrying ${sent} post${sent === 1 ? '' : 's'}.${left.length ? ` ${left.join('; ')}.` : ''}`
      )
    else
      toast.error(
        left.length ? `Nothing was retried: ${left.join('; ')}.` : 'Nothing here can be retried.'
      )
  }
  if (!draftIds.length) return null
  return (
    <Button
      className="h-6 px-2 text-[11px]"
      disabled={busy}
      onClick={() => void run()}
      size={null}
      variant="ghost"
    >
      {busy ? 'Retrying…' : 'Retry all that can be retried'}
    </Button>
  )
}

/** Repeats and crowding in the queue, with a way to select what each is about. */
export function QueueWarnings({
  onSelect,
  warnings,
}: {
  onSelect: (ids: string[]) => void
  warnings: QueueWarning[]
}) {
  if (warnings.length === 0) return null
  return (
    <ul className="mx-3 mt-2 grid gap-1" data-testid="queue-warnings">
      {warnings.map((warning) => (
        <li
          className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-400/40 bg-amber-400/[0.05] px-2 py-1.5 text-[11px] text-amber-800 dark:text-amber-200"
          key={warning.text}
        >
          <span className="flex-1">{warning.text}</span>
          <Button
            className="h-6 px-2 text-[11px]"
            onClick={() => onSelect(warning.ids)}
            size={null}
            variant="ghost"
          >
            Select them
          </Button>
        </li>
      ))}
    </ul>
  )
}
