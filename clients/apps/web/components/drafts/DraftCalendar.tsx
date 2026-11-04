'use client'

import { socialSetHref } from '@/components/workspace/settings-sections'
import * as React from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { type CalendarPostWire, draftsApi } from '@/lib/content-drafts/client'
import { channelForPlatform } from '@/lib/content-drafts/serialize'
import { addDays, zonedDayKey, zonedParts } from '@/lib/settings/zoned-time'
import { availableDaySlots, calendarMoveTime, shiftCalendar } from '@/lib/write/calendar'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ChannelIcon } from './channel-meta'
import { TargetDialog } from '@/components/write/library'
import { CALENDAR_DRAFT_DRAG } from '@/lib/write/calendar'
import { DatePicker } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/** The drag type a calendar post carries. */
const CALENDAR_DRAG = 'application/x-shots-calendar-post'

/** A YYYY-MM-DD day as people read it, without moving it to another zone. */
function readableDay(key: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(`${key}T12:00:00Z`).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' })
}

/** A draft planned for a time: on the calendar, never published by itself. */
export type PlannedDraft = {
  at: string
  caption: string
  draftId: string
  title: string
  tagIds?: string[]
  socialSetId?: string | null
  platform?: string | null
}

/**
 * A week of draft posts in the social set's scheduling time zone (RFC 024):
 * each day's posts in time order, the same for every reader. A queued post
 * drags to another day and keeps its time of day there; live posts stay put.
 * Moving the view's first weekday changes only how the week is drawn.
 * Planned drafts show dashed: they hold a time but publish nothing until
 * scheduled (RFC 025).
 */
export function DraftCalendar({
  view = 'week',
  anchor,
  dayCount = 7,
  workspaceScope = false,
  sets = [],
  tags = [],
  canMove,
  canPlan = false,
  postingSlots = [],
  planned = [],
  posts,
  socialSetId,
  timeZone,
  weekStart,
}: {
  view?: 'week' | 'month' | 'queue'
  anchor?: string
  dayCount?: number
  workspaceScope?: boolean
  sets?: { id: string; name: string }[]
  tags?: { id: string; name: string; color: string }[]
  canMove: boolean
  canPlan?: boolean
  postingSlots?: { weekday: number; time: string }[]
  /** Drafts placed on a day without scheduling. */
  planned?: PlannedDraft[]
  posts: CalendarPostWire[]
  /** The set the calendar shows, kept when moving between weeks. */
  socialSetId?: string
  /** The set's scheduling time zone; days are laid out in it. */
  timeZone: string
  /** The week's first day, as YYYY-MM-DD in `timeZone`. */
  weekStart: string
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [busy, setBusy] = React.useState(false)
  const pending = React.useRef(false)
  const platform = params.get('platform') ?? 'all'
  const status = params.get('status') ?? 'all'
  const tag = params.get('calendarTag') ?? 'all'
  const campaign = params.get('campaign') ?? 'all'
  const filteredSet = params.get('calendarSet') ?? 'all'
  const setFilter = (key: string, value: string) => {
    const query = new URLSearchParams(params)
    if (value === 'all') query.delete(key)
    else query.set(key, value)
    router.replace(`/publish/calendar?${query}`)
  }
  const matches = (item: {
    socialSetId?: string | null
    tagIds?: string[]
    campaignId?: string | null
  }) =>
    (filteredSet === 'all' || item.socialSetId === filteredSet) &&
    (campaign === 'all' || item.campaignId === campaign) &&
    (tag === 'all' || item.tagIds?.includes(tag))
  const visiblePosts = posts.filter(
    (post) =>
      matches(post) &&
      (platform === 'all' || post.platform === platform) &&
      (status === 'all' || post.status === status)
  )
  const [creating, setCreating] = React.useState(false)
  const [picking, setPicking] = React.useState<{ day: string; time: string } | null>(null)
  const [moving, setMoving] = React.useState<{
    id: string
    day: string
    time: string
    swapId: string
  } | null>(null)
  const reviewDraft = (id: string, day: string, time = '09:00') => {
    if (!canPlan) return
    router.push(
      `/publish/${encodeURIComponent(id)}?${new URLSearchParams({ panel: 'schedule', day, time, ...(socialSetId ? { set: socialSetId } : {}) })}`
    )
  }
  const [over, setOver] = React.useState<string | null>(null)
  const days = Array.from({ length: dayCount }, (_, index) => addDays(weekStart, index))
  const calendarHref = (step: number | null, mode = view) => {
    const query = new URLSearchParams(params.toString())
    query.set('view', mode)
    if (step === null) query.delete('week')
    else query.set('week', shiftCalendar(anchor ?? weekStart, view, step))
    return `/publish/calendar?${query}`
  }
  const commit = async (mutation: () => Promise<unknown>) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try {
      await mutation()
      toast.success('Calendar updated.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The calendar could not be updated.')
    } finally {
      // Also refresh uncertain responses: the database may have committed before
      // a workflow wake-up failed. Cards only move when the server confirms it.
      router.refresh()
      pending.current = false
      setBusy(false)
    }
  }
  const move = async (postId: string, day: string, time?: string) => {
    if (!canMove) return
    const post = posts.find((item) => item.id === postId && item.status === 'SCHEDULED')
    if (!post) return
    const from = new Date(post.slotAt ?? post.scheduledFor)
    const clock = zonedParts(from, timeZone)
    try {
      const to = calendarMoveTime(
        day,
        time ?? `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`,
        timeZone
      )
      if (to.getTime() <= Date.now() + 60_000)
        throw new Error('Pick a time at least one minute in the future.')
      if (to.getTime() === from.getTime()) return
      await commit(() => draftsApi.movePost(postId, to))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The post could not move.')
    }
  }
  const swap = (postId: string, target: CalendarPostWire) => {
    if (!canMove || target.id === postId) return
    const source = posts.find((post) => post.id === postId)
    if (
      !source ||
      source.status !== 'SCHEDULED' ||
      target.status !== 'SCHEDULED' ||
      source.channelConnectionId !== target.channelConnectionId
    ) {
      toast.error('Only queued posts on the same account can swap.')
      return
    }
    void commit(() => draftsApi.swapPosts(postId, target.id))
  }
  const plan = async (day: string, time?: string) => {
    if (creating) return
    setCreating(true)
    try {
      const draft = await draftsApi.create({ socialSetId })
      const query = new URLSearchParams({
        panel: 'schedule',
        day,
        ...(time ? { time } : {}),
        ...(socialSetId ? { set: socialSetId } : {}),
      })
      router.push(`/publish/${draft.id}?${query}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The draft could not be created.')
      setCreating(false)
    }
  }
  const today = zonedDayKey(new Date(), timeZone)
  return (
    <div
      className="flex h-full flex-col"
      aria-busy={busy}
      onKeyDown={(event) => {
        if (
          event.target instanceof HTMLElement &&
          event.target.closest('input,select,textarea,[contenteditable]')
        )
          return
        if (event.altKey && ['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) {
          event.preventDefault()
          router.push(
            calendarHref(event.key === 'Home' ? null : event.key === 'ArrowLeft' ? -1 : 1)
          )
        }
      }}
    >
      {picking ? (
        <TargetDialog
          kind={{ kind: 'repurpose', label: 'Repurpose published posts', needs: 'source' }}
          onClose={() => setPicking(null)}
          onCreate={(target) => {
            const slot = picking
            setPicking(null)
            void draftsApi
              .create({ kind: 'repurpose', socialSetId, target })
              .then((draft) => reviewDraft(draft.id, slot.day, slot.time))
              .catch((error: unknown) =>
                toast.error(
                  error instanceof Error ? error.message : 'The post could not be repurposed.'
                )
              )
          }}
        />
      ) : null}
      <Dialog
        open={moving !== null}
        onOpenChange={(open) => {
          if (!open) setMoving(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move queued post</DialogTitle>
            <DialogDescription>
              Choose a new time in {timeZone}, or swap with another queued post on this account.
            </DialogDescription>
          </DialogHeader>
          {moving ? (
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                const chosen = moving
                setMoving(null)
                if (chosen.swapId) {
                  const target = posts.find((post) => post.id === chosen.swapId)
                  if (target) swap(chosen.id, target)
                } else void move(chosen.id, chosen.day, chosen.time)
              }}
            >
              <Label className="grid gap-1">
                Day
                <DatePicker
                  aria-label="Day"
                  value={moving.day}
                  onChange={(day) => setMoving({ ...moving, day })}
                />
              </Label>
              <Label className="grid gap-1">
                Time
                <Input
                  type="time"
                  required
                  value={moving.time}
                  onChange={(event) => setMoving({ ...moving, time: event.target.value })}
                />
              </Label>
              <Label className="grid gap-1">
                Swap with
                <NativeSelect
                  value={moving.swapId}
                  onChange={(event) => setMoving({ ...moving, swapId: event.target.value })}
                >
                  <NativeSelectOption value="">Use the date and time above</NativeSelectOption>
                  {posts
                    .filter(
                      (post) =>
                        Boolean(post.draftId) &&
                        post.id !== moving.id &&
                        post.status === 'SCHEDULED' &&
                        post.channelConnectionId ===
                          posts.find((item) => item.id === moving.id)?.channelConnectionId
                    )
                    .map((post) => (
                      <NativeSelectOption value={post.id} key={post.id}>
                        {post.caption.slice(0, 50)} ·{' '}
                        {new Date(post.slotAt ?? post.scheduledFor).toLocaleString(undefined, {
                          timeZone,
                        })}
                      </NativeSelectOption>
                    ))}
                </NativeSelect>
              </Label>
              <DialogFooter>
                <Button disabled={busy} type="submit">
                  {moving.swapId ? 'Confirm swap' : 'Confirm move'}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-3 py-2 border-b border-foreground/[0.06] px-4">
        <h2 className="text-ui-lg font-medium text-foreground">
          {view === 'month'
            ? readableDay(`${(anchor ?? weekStart).slice(0, 7)}-01`, {
                month: 'long',
                year: 'numeric',
              })
            : `Week of ${readableDay(weekStart, { day: 'numeric', month: 'long' })}`}
        </h2>
        <span className="text-xs text-muted-foreground">{timeZone.replaceAll('_', ' ')}</span>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <Link className="text-foreground/65 hover:text-foreground" href={calendarHref(-1)}>
            ← Previous
          </Link>
          <Link className="text-foreground/65 hover:text-foreground" href={calendarHref(null)}>
            Today
          </Link>
          <Link className="text-foreground/65 hover:text-foreground" href={calendarHref(1)}>
            Next →
          </Link>
        </div>
      </header>
      <nav
        aria-label="Calendar controls"
        className="flex flex-wrap items-center gap-3 border-b px-4 py-2 text-xs"
      >
        {(['week', 'month', 'queue'] as const).map((mode) => (
          <Link
            key={mode}
            aria-current={view === mode ? 'page' : undefined}
            className="capitalize aria-[current=page]:font-bold"
            href={calendarHref(0, mode)}
          >
            {mode}
          </Link>
        ))}
        <NativeSelect
          aria-label="Filter by platform"
          size="sm"
          value={platform}
          onChange={(event) => setFilter('platform', event.target.value)}
        >
          <NativeSelectOption value="all">All platforms</NativeSelectOption>
          {[...new Set(posts.map((post) => post.platform))].map((item) => (
            <NativeSelectOption key={item}>{item}</NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Filter by campaign"
          size="sm"
          value={campaign}
          onChange={(event) => setFilter('campaign', event.target.value)}
        >
          <NativeSelectOption value="all">All campaigns and drafts</NativeSelectOption>
          {Array.from(
            new Set(posts.flatMap((post) => (post.campaignId ? [post.campaignId] : [])))
          ).map((id) => (
            <NativeSelectOption key={id} value={id}>
              {posts.find((post) => post.campaignId === id)?.campaignTitle ?? 'Campaign'}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Filter by status"
          size="sm"
          value={status}
          onChange={(event) => setFilter('status', event.target.value)}
        >
          <NativeSelectOption value="all">All statuses</NativeSelectOption>
          {['planned', 'SCHEDULED', 'PROCESSING', 'PUBLISHED', 'FAILED', 'UNKNOWN_DELIVERY'].map(
            (item) => (
              <NativeSelectOption key={item}>{item}</NativeSelectOption>
            )
          )}
        </NativeSelect>
        {workspaceScope ? (
          <NativeSelect
            aria-label="Calendar publishing brand"
            size="sm"
            value={filteredSet}
            onChange={(event) => setFilter('calendarSet', event.target.value)}
          >
            <NativeSelectOption value="all">All publishing brands</NativeSelectOption>
            {sets.map((set) => (
              <NativeSelectOption key={set.id} value={set.id}>
                {set.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : null}
        {tags.length ? (
          <NativeSelect
            aria-label="Calendar tag"
            size="sm"
            value={tag}
            onChange={(event) => setFilter('calendarTag', event.target.value)}
          >
            <NativeSelectOption value="all">All tags</NativeSelectOption>
            {tags.map((item) => (
              <NativeSelectOption key={item.id} value={item.id}>
                {item.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : null}
        <Link
          href={`/publish/calendar?${new URLSearchParams({ ...Object.fromEntries(params), scope: workspaceScope ? 'set' : 'workspace' })}`}
        >
          {workspaceScope ? 'Show this publishing brand' : 'All publishing brands'}
        </Link>
        <Link href={socialSetId ? socialSetHref(socialSetId, 'scheduling') : '/settings/publishing-brands'}>
          Schedule settings
        </Link>
        <span className="text-muted-foreground">Alt + ←/→: navigate · Alt + Home: today</span>
      </nav>
      {/* Local: the site-wide GlobalDropZone would otherwise force a "copy"
          dropEffect on every dragover, which a moved card refuses. */}
      <div
        className="grid min-h-0 flex-1 auto-rows-max content-start grid-cols-[repeat(7,minmax(140px,1fr))] divide-x divide-foreground/[0.05] overflow-auto"
        data-local-dropzone=""
      >
        {days.map((day) => {
          const key = day
          const dayPosts = visiblePosts.filter(
            (post) => zonedDayKey(new Date(post.scheduledFor), timeZone) === key
          )
          const dayPlanned = (status === 'all' || status === 'planned' ? planned : []).filter(
            (item) =>
              matches(item) &&
              (platform === 'all' || item.platform === platform) &&
              zonedDayKey(new Date(item.at), timeZone) === key
          )
          return (
            <section
              aria-label={readableDay(day, {
                day: 'numeric',
                month: 'long',
                weekday: 'long',
                year: 'numeric',
              })}
              className={cn(
                'flex min-h-40 min-w-0 flex-col gap-2 p-2',
                over === key && 'bg-sky-400/[0.06]'
              )}
              data-testid={`calendar-day-${Number(day.slice(8))}`}
              data-day={day}
              key={key}
              onDragLeave={() => setOver(null)}
              onDragOver={(event) => {
                if (
                  !event.dataTransfer.types.includes(CALENDAR_DRAG) &&
                  !event.dataTransfer.types.includes(CALENDAR_DRAFT_DRAG)
                )
                  return
                event.preventDefault()
                event.dataTransfer.dropEffect = event.dataTransfer.types.includes(
                  CALENDAR_DRAFT_DRAG
                )
                  ? 'copy'
                  : 'move'
                setOver(key)
              }}
              onDrop={(event) => {
                setOver(null)
                const draftId = event.dataTransfer.getData(CALENDAR_DRAFT_DRAG)
                if (draftId) {
                  event.preventDefault()
                  reviewDraft(draftId, day)
                  return
                }
                const postId = event.dataTransfer.getData(CALENDAR_DRAG)
                if (!postId) return
                // Do not follow the dragged link.
                event.preventDefault()
                void move(postId, day)
              }}
            >
              <p
                className={cn(
                  'text-xs',
                  key === today ? 'text-sky-700 dark:text-sky-300' : 'text-muted-foreground'
                )}
              >
                {readableDay(day, { day: 'numeric', weekday: 'short' })}
              </p>
              {canPlan && day >= today ? (
                <div className="grid gap-1">
                  <Button
                    className="h-auto min-h-8 whitespace-normal px-1 text-xs"
                    disabled={creating}
                    size="sm"
                    variant="outline"
                    onClick={() => void plan(day)}
                  >
                    Plan a post
                  </Button>
                  {availableDaySlots(day, timeZone, postingSlots, [
                    ...posts.map((post) => post.slotAt ?? post.scheduledFor),
                    ...planned.map((item) => item.at),
                  ]).map((time) => (
                    <div className="grid gap-1" key={time}>
                      <Button
                        className="h-auto min-h-8 whitespace-normal px-1 text-xs"
                        disabled={creating}
                        size="sm"
                        variant="ghost"
                        onClick={() => void plan(day, time)}
                        onDragOver={(event) => {
                          if (
                            event.dataTransfer.types.includes(CALENDAR_DRAG) ||
                            event.dataTransfer.types.includes(CALENDAR_DRAFT_DRAG)
                          )
                            event.preventDefault()
                        }}
                        onDrop={(event) => {
                          const draftId = event.dataTransfer.getData(CALENDAR_DRAFT_DRAG)
                          if (draftId) {
                            event.preventDefault()
                            event.stopPropagation()
                            reviewDraft(draftId, day, time)
                            return
                          }
                          const id = event.dataTransfer.getData(CALENDAR_DRAG)
                          if (!id) return
                          event.preventDefault()
                          event.stopPropagation()
                          setOver(null)
                          void move(id, day, time)
                        }}
                      >
                        Available · {time}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setPicking({ day, time })}>
                        Pick
                      </Button>
                    </div>
                  ))}
                </div>
              ) : null}
              {dayPlanned.map((item) => (
                <Link
                  className="block rounded-lg border border-dashed border-foreground/20 p-2 text-xs"
                  data-testid="calendar-planned"
                  href={`/publish/${item.draftId}`}
                  key={`planned-${item.draftId}`}
                >
                  <span className="text-muted-foreground">
                    Planned ·{' '}
                    {new Date(item.at).toLocaleTimeString(undefined, {
                      hour: 'numeric',
                      minute: '2-digit',
                      timeZone,
                    })}
                  </span>
                  <span className="mt-1 line-clamp-2 block text-foreground">
                    {item.title && item.title !== 'Untitled draft'
                      ? item.title
                      : item.caption || item.title}
                  </span>
                  <span className="flex flex-wrap gap-1">
                    {tags
                      .filter((tag) => item.tagIds?.includes(tag.id))
                      .map((tag) => (
                        <span className="rounded border px-1" key={tag.id}>
                          {tag.name}
                        </span>
                      ))}
                  </span>
                </Link>
              ))}
              {dayPosts.map((post) => {
                const channel = channelForPlatform(post.platform)
                const movable =
                  !busy && canMove && Boolean(post.draftId) && post.status === 'SCHEDULED'
                return (
                  <div className="grid gap-1" key={post.id}>
                    <Link
                      className={cn(
                        'block rounded-lg border p-2 text-xs',
                        post.status === 'PUBLISHED'
                          ? 'border-emerald-400/20 bg-emerald-400/[0.04]'
                          : 'border-foreground/[0.08] bg-foreground/[0.02] hover:border-foreground/20',
                        movable && 'cursor-grab'
                      )}
                      data-testid="calendar-post"
                      draggable={movable}
                      href={
                        post.campaignId ? `/campaigns/${post.campaignId}` : `/publish/${post.draftId}`
                      }
                      onDragOver={(event) => {
                        if (movable && event.dataTransfer.types.includes(CALENDAR_DRAG))
                          event.preventDefault()
                      }}
                      onDrop={(event) => {
                        if (!movable) return
                        const id = event.dataTransfer.getData(CALENDAR_DRAG)
                        if (!id) return
                        event.preventDefault()
                        event.stopPropagation()
                        setOver(null)
                        swap(id, post)
                      }}
                      onDragStart={(event) => {
                        event.dataTransfer.setData(CALENDAR_DRAG, post.id)
                        event.dataTransfer.effectAllowed = 'move'
                      }}
                    >
                      <span className="flex items-center gap-1 text-foreground/65">
                        {channel ? <ChannelIcon channel={channel} /> : null}
                        {new Date(post.scheduledFor).toLocaleTimeString(undefined, {
                          hour: 'numeric',
                          minute: '2-digit',
                          timeZone,
                        })}
                        {` · ${post.status === 'PUBLISHED' && post.threadProgress.posted < post.threadProgress.total ? 'partially published' : post.status.toLowerCase().replaceAll('_', ' ')}`}
                      </span>
                      <span className="mt-1 line-clamp-3 block text-foreground">
                        {post.caption}
                      </span>
                      <span className="text-muted-foreground">
                        {post.campaignTitle ? `${post.campaignTitle} · ` : null}
                        {sets.find((set) => set.id === post.socialSetId)?.name}
                      </span>
                      <span className="flex flex-wrap gap-1">
                        {tags
                          .filter((tag) => post.tagIds.includes(tag.id))
                          .map((tag) => (
                            <span className="rounded border px-1" key={tag.id}>
                              {tag.name}
                            </span>
                          ))}
                      </span>
                    </Link>
                    {movable ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Move ${post.caption.slice(0, 50)}`}
                        onClick={() => {
                          const at = new Date(post.slotAt ?? post.scheduledFor)
                          const clock = zonedParts(at, timeZone)
                          setMoving({
                            id: post.id,
                            day: zonedDayKey(at, timeZone),
                            time: `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`,
                            swapId: '',
                          })
                        }}
                      >
                        Change time or swap
                      </Button>
                    ) : null}
                  </div>
                )
              })}
            </section>
          )
        })}
      </div>
    </div>
  )
}
