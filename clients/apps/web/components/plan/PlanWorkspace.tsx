'use client'

import * as React from 'react'
import { readWire } from '@/lib/plan/wire'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { ArrowLeftIcon } from '@phosphor-icons/react/dist/ssr/ArrowLeft'
import { CaretDownIcon } from '@phosphor-icons/react/dist/ssr/CaretDown'
import { CaretLeftIcon } from '@phosphor-icons/react/dist/ssr/CaretLeft'
import { CaretRightIcon } from '@phosphor-icons/react/dist/ssr/CaretRight'
import { CheckCircleIcon } from '@phosphor-icons/react/dist/ssr/CheckCircle'
import { ClockIcon } from '@phosphor-icons/react/dist/ssr/Clock'
import { FunnelSimpleIcon } from '@phosphor-icons/react/dist/ssr/FunnelSimple'
import { PlusIcon } from '@phosphor-icons/react/dist/ssr/Plus'
import { SlidersHorizontalIcon } from '@phosphor-icons/react/dist/ssr/SlidersHorizontal'
import { NoteIcon } from '@phosphor-icons/react/dist/ssr/Note'
import { WarningIcon } from '@phosphor-icons/react/dist/ssr/Warning'
import { WarningCircleIcon } from '@phosphor-icons/react/dist/ssr/WarningCircle'
import { toast } from 'sonner'
import type { Value } from '@shots/platejs-editor/platejs'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { DAY_STYLE, useWhen, WHEN_STYLE } from '@/components/drafts/local-time'
import { Pill } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DatePicker } from '@/components/ui/date-picker'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { useTwelveHour } from '@/components/ui/format-preferences'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TimePicker } from '@/components/ui/time-picker'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { useShortcuts } from '@/components/write/shortcuts'
import { calendarPostSchema } from '@/lib/api/contracts/content-draft-platform'
import { contentDraftSchema } from '@/lib/api/contracts/content-drafts'
import { calendarNoteListSchema, type CalendarNoteWire } from '@/lib/api/contracts/calendar-notes'
import { calendarResultSchema, type CalendarPlacement } from '@/lib/api/contracts/plan-analyze'
import { call, draftsApi, type DraftWire, type DraftPostWire } from '@/lib/content-drafts/client'
import {
  currentPosts,
  POST_STATE_TONE,
  postFailureReason,
  postState,
  STATUS_GROUPS,
} from '@/lib/content-drafts/post-status'
import { draftPlainText, channelForPlatform, platformLabel } from '@/lib/content-drafts/serialize'
import {
  writeApi,
  type SocialSetWire,
  type DraftTagWire,
} from '@/lib/write/client'
import { wallTime, isTimeZone, localDateTimeSchema, resolveLocalTime } from '@/lib/write/zoned-time'
import { addDays, zonedDayKey, zonedInstant } from '@/lib/settings/zoned-time'
import { formatTimeOfDay } from '@/lib/time-of-day'
import { zoneLabel } from '@/lib/time-zones'
import {
  brandDaySlots,
  calendarDays,
  itemDay,
  occurrence,
  planPreferencesSchema,
  movedToDay,
  selectedInstant,
  takenSlots,
  selectionState,
  shiftAnchor,
  validDay,
  visibleDayItems,
  visibleItems,
  weekCardLayout,
  type PlanItem,
  type PlanPreferences,
} from '@/lib/plan/calendar'
import { DraftHistory } from '@/components/drafts/DraftHistory'
import { DraftSettingsDrawer, openBrandSettings } from '@/components/drafts/DraftSettingsDrawer'
import { NoteChip, NoteDialog } from './CalendarNotes'
import { WorkspaceNav } from './WorkspaceNav'
import { useDraftSources } from './useDraftSources'

const QuickBody = dynamic(() => import('./QuickBody'), {
  ssr: false,
  loading: () => <p role="status">Loading editor…</p>,
})
const DRAG = 'application/x-shots-calendar-placement'
const readable = (
  day: string,
  options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
) => new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { ...options, timeZone: 'UTC' })
const toggle = (values: string[], value: string) =>
  values.includes(value) ? values.filter((v) => v !== value) : [...values, value]
const CARD_TIME: Intl.DateTimeFormatOptions = {
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
}
const STATUS_ICONS: Record<string, typeof WarningIcon> = {
  Failed: WarningCircleIcon,
  'Needs check': WarningIcon,
  Overdue: WarningIcon,
  Published: CheckCircleIcon,
}

/** A card's state in words, with an icon on the outcomes: its border colour never says it alone. */
function StatusWord({ status }: { status: string }) {
  const Icon = STATUS_ICONS[status]
  return (
    <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
      {Icon ? <Icon aria-hidden className="size-3 shrink-0" /> : null}
      {status}
    </span>
  )
}

/** Cards a calendar day shows before the rest scroll inside it. */
const DAY_VISIBLE = 4
/** Pixels of padding (p-1.5) around a day's cards, for the focus outline. */
const FOCUS_ROOM = 6

/** A day list's cards whose middle is past its visible bottom. */
const belowFold = (element: HTMLElement) =>
  ([...element.children] as HTMLElement[]).filter(
    (card) => card.offsetTop + card.offsetHeight / 2 > element.scrollTop + element.clientHeight
  )

/**
 * A day's cards. Past the fourth they scroll inside the day, so a day with a
 * hundred posts never stretches its week, and "N more" counts those below.
 * `ids` re-measures when the cards change; resizes re-measure on their own.
 */
function DayList({ children, ids }: { children: React.ReactNode; ids: string }) {
  const list = React.useRef<HTMLDivElement>(null)
  const [limit, setLimit] = React.useState<number>()
  const [below, setBelow] = React.useState(0)
  const measure = React.useCallback(() => {
    const element = list.current
    if (!element) return
    const last = element.children[DAY_VISIBLE - 1] as HTMLElement | undefined
    // The list's padding is the room a focused card's outline needs inside the scroll box.
    setLimit(
      element.children.length > DAY_VISIBLE && last
        ? last.offsetTop + last.offsetHeight + FOCUS_ROOM
        : undefined
    )
    setBelow(belowFold(element).length)
  }, [])
  React.useLayoutEffect(() => {
    const element = list.current
    if (!element) return
    // Four or fewer never scroll, so a quiet day keeps no observer.
    if (element.children.length <= DAY_VISIBLE) {
      setLimit(undefined)
      setBelow(0)
      return
    }
    measure()
    // Width, density and wrapping change card heights, so the cards are watched too.
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const card of element.children) observer.observe(card)
    return () => observer.disconnect()
  }, [measure, ids])
  return (
    <>
      <div
        className={`relative -m-1.5 grid gap-2 p-1.5 ${limit === undefined ? '' : 'overflow-y-auto'}`}
        data-testid="calendar-day-list"
        onScroll={measure}
        ref={list}
        style={{ maxHeight: limit }}
      >
        {children}
      </div>
      {below > 0 ? (
        <Button
          aria-label={`Scroll to ${below} more ${below === 1 ? 'post' : 'posts'}`}
          className="h-auto justify-start gap-1 px-1 py-0.5 text-xs font-normal text-muted-foreground"
          onClick={() => {
            const element = list.current
            if (!element) return
            // Focus moves to the first revealed card: this button goes once nothing is below.
            belowFold(element)[0]?.focus({ preventScroll: true })
            element.scrollBy({
              behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
                ? 'auto'
                : 'smooth',
              top: element.clientHeight,
            })
          }}
          size={null}
          variant="ghost"
        >
          <CaretDownIcon aria-hidden className="size-3" />
          {below} more
        </Button>
      ) : null}
    </>
  )
}

/** Plan uses the existing drafts and publishing APIs, with independent personal view state. */
export function PlanWorkspace({
  sets,
  canEdit,
  canManageSets = false,
  canPublish,
  preferenceKey,
  initialZone,
  initialWeekStart,
  initialDay,
  initialView,
  advancedScheduling = false,
}: {
  sets: SocialSetWire[]
  canEdit: boolean
  /** May change a brand's settings (workspace:update), in the sheet "Edit schedule" opens. */
  canManageSets?: boolean
  canPublish: boolean
  preferenceKey: string
  initialZone: string
  initialWeekStart: 0 | 1
  initialDay?: string
  initialView?: string
  advancedScheduling?: boolean
}) {
  const router = useRouter()
  const when = useWhen()
  const twelveHour = useTwelveHour()
  const [prefs, setPrefs] = React.useState<PlanPreferences>(() =>
    planPreferencesSchema.parse({
      weekStart: initialWeekStart,
      view:
        initialView === 'queue'
          ? 'week'
          : ['flex', 'month', 'week'].includes(initialView ?? '')
            ? initialView
            : 'flex',
    })
  )
  const [anchor, setAnchor] = React.useState(
    initialDay && validDay(initialDay) ? initialDay : zonedDayKey(new Date(), initialZone)
  )
  const [hydrated, setHydrated] = React.useState(false)
  const [weeks, setWeeks] = React.useState(3)
  const container = React.useRef<HTMLDivElement>(null)
  const [items, setItems] = React.useState<PlanItem[]>([])
  const [load, setLoad] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [failure, setFailure] = React.useState('')
  const [refresh, setRefresh] = React.useState(0)
  const [sidebar, setSidebar] = React.useState<string | null>(null)
  const [source, setSource] = React.useState<'drafts' | 'posted'>('drafts')
  const [search, setSearch] = React.useState('')
  const sourceList = useDraftSources(sidebar, source, search, refresh)
  const { items: sources, error: sourceError } = sourceList
  const [tags, setTags] = React.useState<DraftTagWire[]>([])
  const [tagsUnavailable, setTagsUnavailable] = React.useState(false)
  const [compose, setCompose] = React.useState<{
    day: string
    time: string
    setId: string
    selected?: DraftWire
    source?: 'drafts' | 'posted'
  } | null>(null)
  const [detail, setDetail] = React.useState<PlanItem | null>(null)
  const [over, setOver] = React.useState<string | null>(null)
  const [openDays, setOpenDays] = React.useState<string[]>([])
  const [notes, setNotes] = React.useState<CalendarNoteWire[]>([])
  const [notesFailed, setNotesFailed] = React.useState(false)
  const [noteEdit, setNoteEdit] = React.useState<{ day: string; note?: CalendarNoteWire } | null>(
    null
  )
  const [busy, setBusy] = React.useState(false)
  const activeIds = prefs.visible ?? sets.map((s) => s.id)
  const focused = activeIds.length === 1 ? sets.find((s) => s.id === activeIds[0]) : undefined
  const days = calendarDays(anchor, prefs.view, prefs.weekStart, weeks)
  const rangeKey = `${days[0]}:${days.at(-1)}`
  // Each post sits on its own brand's clock; "today" and a new draft follow the first brand in view.
  const today = zonedDayKey(
    new Date(),
    sets.find((s) => s.id === activeIds[0])?.timeZone ?? initialZone
  )
  const shown = visibleItems(items, prefs).filter((item) => days.includes(itemDay(item)))
  const weekCardHeight = prefs.density === 'compact' ? 88 : 120
  const weekLayouts = Object.fromEntries(
    prefs.view === 'week'
      ? days.map((day) => [
          day,
          weekCardLayout(
            shown.filter((item) => itemDay(item) === day),
            weekCardHeight
          ),
        ])
      : []
  )
  const setPref = (patch: Partial<PlanPreferences>) => setPrefs((p) => ({ ...p, ...patch }))
  const allState = selectionState(
    prefs.visible,
    sets.map((s) => s.id)
  )
  const reload = () => setRefresh((n) => n + 1)

  React.useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(preferenceKey) ?? 'null')
      const parsed = planPreferencesSchema.safeParse(saved?.prefs)
      if (parsed.success)
        setPrefs({
          ...parsed.data,
          visible: parsed.data.visible?.filter((id) => sets.some((s) => s.id === id)) ?? null,
        })
      if (!initialDay && saved?.anchor && validDay(saved.anchor)) setAnchor(saved.anchor)
    } catch {
      /* Corrupt or blocked local storage uses the account defaults. */
    }
    setHydrated(true)
  }, [preferenceKey, initialDay, sets])
  React.useEffect(() => {
    if (hydrated) {
      try {
        localStorage.setItem(preferenceKey, JSON.stringify({ prefs, anchor }))
      } catch {
        /* Preferences remain usable in memory. */
      }
    }
  }, [prefs, anchor, hydrated, preferenceKey])
  // Measured before the first load: fitting the weeks later changed the range and loaded it twice.
  React.useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const fit = (height: number) => setWeeks(Math.max(1, Math.min(8, Math.floor(height / 160))))
    fit(element.clientHeight)
    const observer = new ResizeObserver(([entry]) => fit(entry.contentRect.height))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  React.useEffect(() => {
    if (!hydrated) return
    const controller = new AbortController()
    setLoad('loading')
    setItems([])
    const [start, end] = rangeKey.split(':')
    // Any brand's day falls within a day either side of the range in UTC; `shown` trims the rest.
    const query = new URLSearchParams({
      from: zonedInstant(addDays(start, -1), 0, 0, 'UTC').toISOString(),
      to: zonedInstant(addDays(end, 2), 0, 0, 'UTC').toISOString(),
    })
    const read = async (path: string) => {
      const r = await fetch(`${path}?${query}`, { signal: controller.signal })
      const b = await r.json()
      if (!r.ok) throw new Error(b.message ?? 'Calendar could not load.')
      return b
    }
    Promise.all([read('/api/v1/content-draft-posts'), read('/api/v1/content-draft-plans')])
      .then(([posts, plans]) => {
        if (controller.signal.aborted) return
        const content: PlanItem[] = posts.items.map((raw: unknown) => {
          const p = readWire(calendarPostSchema, raw)
          return {
            id: p.id,
            postId: p.id,
            draftId: p.draftId,
            campaignId: p.campaignId,
            version: p.version,
            calendarVersion: p.calendarVersion,
            setId: p.socialSetId ?? '',
            accountId: p.channelConnectionId,
            platform: p.platform,
            // Placed at its slot; publishAt is the instant after any natural offset.
            // A live post reads when it went out, as the Posted list dates it.
            // The library's date filter uses this instant too: draftPostsMatch in Go.
            at: p.publishedAt ?? p.slotAt ?? p.scheduledFor,
            publishAt: p.publishedAt ?? p.scheduledFor,
            zone:
              sets.find((s) => s.id === p.socialSetId)?.timeZone ??
              p.scheduleTimeZone ??
              initialZone,
            deliveryStatus: p.status,
            status: postState(p.status, p.scheduledFor),
            failureCode: p.failureCode,
            title: p.draftTitle,
            text: p.caption,
            tagIds: p.tagIds,
            url: p.url,
          }
        })
        for (const raw of plans.items) {
          const d = readWire(contentDraftSchema, raw)
          if (d.plannedFor)
            content.push({
              id: d.id,
              draftId: d.id,
              version: d.version,
              calendarVersion: d.calendarVersion,
              setId: d.socialSetId ?? '',
              platform: d.primaryPlatform ?? '',
              at: d.plannedFor,
              zone:
                sets.find((s) => s.id === d.socialSetId)?.timeZone ?? d.planTimeZone ?? initialZone,
              status: 'Planned',
              title: d.title,
              text: d.plainText || draftPlainText(d.body),
              tagIds: d.tagIds,
            })
        }
        setItems(content)
        setLoad('ready')
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setFailure(e.message)
          setLoad('error')
        }
      })
    return () => controller.abort()
  }, [rangeKey, refresh, hydrated, sets, initialZone])
  // Notes are dates: no zone is applied, and a failure here leaves the posts usable.
  React.useEffect(() => {
    if (!hydrated) return
    const controller = new AbortController()
    const [from, to] = rangeKey.split(':')
    setNotesFailed(false)
    fetch(`/api/v1/calendar/notes?${new URLSearchParams({ from, to })}`, {
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error('Notes could not load.')
        setNotes(readWire(calendarNoteListSchema, await r.json()).items)
      })
      .catch(() => {
        if (!controller.signal.aborted) setNotesFailed(true)
      })
    return () => controller.abort()
  }, [rangeKey, refresh, hydrated])
  const scopeKey = activeIds.slice().sort().join(',')
  React.useEffect(() => {
    // The saved brand selection loads first; reading tags before it read them twice.
    if (!hydrated) return
    let cancelled = false
    setTags([])
    setTagsUnavailable(false)
    Promise.allSettled(
      scopeKey
        .split(',')
        .filter(Boolean)
        .map((id) => writeApi.tags(id))
    ).then((results) => {
      if (cancelled) return
      setTags(results.flatMap((r) => (r.status === 'fulfilled' ? r.value.items : [])))
      setTagsUnavailable(results.some((r) => r.status === 'rejected'))
    })
    return () => {
      cancelled = true
    }
  }, [scopeKey, refresh, hydrated])

  const changePeriod = (amount: number) =>
    setAnchor((day) => shiftAnchor(day, prefs.view, amount, weeks))
  useShortcuts([
    ...(['f', 'm', 'w'] as const).map((key, i) => ({
      key,
      label: 'Calendar view',
      run: () => setPref({ view: (['flex', 'month', 'week'] as const)[i] }),
    })),
    {
      key: 'v',
      label: 'Cycle calendar view',
      run: () =>
        setPref({
          view: prefs.view === 'flex' ? 'month' : prefs.view === 'month' ? 'week' : 'flex',
        }),
    },
    { key: 't', label: 'Today', run: () => setAnchor(today) },
    { key: 'arrowleft', label: 'Previous period', run: () => changePeriod(-1) },
    { key: 'arrowright', label: 'Next period', run: () => changePeriod(1) },
    { key: 'escape', label: 'Back to profiles', run: () => setSidebar(null) },
  ])
  const placement = (item: PlanItem, at: string | null): CalendarPlacement => ({
    draftId: item.draftId,
    version: item.version,
    calendarVersion: item.calendarVersion,
    postId: item.postId,
    at,
    timeZone: item.zone,
  })
  const mutationKeys = React.useRef(new Map<string, string>())
  const mutate = async (
    action: 'move' | 'swap' | 'unschedule' | 'remove_date',
    changes: CalendarPlacement[]
  ) => {
    if (busy) return
    const fingerprint = JSON.stringify({ action, items: changes })
    let mutationKey = mutationKeys.current.get(fingerprint)
    if (!mutationKey) {
      mutationKey = crypto.randomUUID()
      mutationKeys.current.set(fingerprint, mutationKey)
    }
    setBusy(true)
    try {
      const result = readWire(
        calendarResultSchema,
        await call('/api/v1/calendar/mutations', {
          method: 'POST',
          body: { key: mutationKey, action, items: changes },
        })
      )
      reload()
      setDetail(null)
      toast.success(
        action === 'unschedule' ? 'Unscheduled. The date is kept as a plan.' : 'Calendar updated.',
        result.undo.length
          ? {
              action: {
                label: 'Undo',
                onClick: () => void mutate(result.undo.length === 2 ? 'swap' : 'move', result.undo),
              },
            }
          : undefined
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Calendar change failed.', {
        action: { label: 'Retry', onClick: () => void mutate(action, changes) },
      })
      reload()
    } finally {
      setBusy(false)
    }
  }
  const drop = (event: React.DragEvent, day: string, hour?: number, target?: PlanItem) => {
    event.preventDefault()
    event.stopPropagation()
    setOver(null)
    const id = event.dataTransfer.getData(DRAG)
    const item = items.find((i) => i.id === id)
    if (!item) {
      const draft = sources?.find((d) => d.id === id)
      if (draft)
        create(day, `${String(hour ?? 12).padStart(2, '0')}:00`, {
          setId: draft.socialSetId ?? undefined,
          selected: draft,
          source,
        })
      return
    }
    if (
      advancedScheduling &&
      target &&
      !target.campaignId &&
      target.id !== item.id &&
      target.setId === item.setId &&
      ['Planned', 'Scheduled'].includes(target.status)
    ) {
      void mutate('swap', [placement(item, target.at), placement(target, item.at)])
      return
    }
    try {
      // A day keeps the post's clock; a week hour is that hour on its brand's clock.
      const at =
        hour === undefined
          ? movedToDay(item.at, item.zone, day)
          : selectedInstant(`${day}T${String(hour).padStart(2, '0')}:00`, item.zone, 'reject')
      void mutate('move', [placement(item, at.toISOString())])
    } catch (e) {
      toast.error((e as Error).message)
    }
  }
  const card = (item: PlanItem, weekly = false) => (
    <Button
      key={item.id}
      size={null}
      type="button"
      variant="custom"
      data-testid={item.status === 'Planned' ? 'calendar-planned' : 'calendar-post'}
      aria-label={`${item.status}: ${item.text || item.title}, ${sets.find((s) => s.id === item.setId)?.name ?? 'Account'}, ${platformLabel(item.platform)}`}
      draggable={
        !busy &&
        !item.campaignId &&
        (item.status === 'Planned'
          ? canEdit
          : ['Scheduled', 'Overdue'].includes(item.status) && canPublish)
      }
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG, item.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG)) e.preventDefault()
      }}
      onDrop={(e) => drop(e, itemDay(item), undefined, item)}
      onClick={() =>
        item.campaignId ? router.push(`/campaigns/${item.campaignId}`) : setDetail(item)
      }
      className={`block h-auto w-full min-w-0 rounded-lg border p-1.5 text-left text-xs font-normal whitespace-normal shadow-sm ${weekly ? 'h-full overflow-hidden' : ''} ${item.status === 'Planned' ? 'border-dashed border-violet-400' : item.status === 'Published' ? 'border-emerald-500' : item.status === 'Failed' ? 'border-red-500' : item.status === 'Needs check' || item.status === 'Overdue' ? 'border-amber-500' : 'border-sky-500'} bg-background`}
    >
      {/* One line while they fit, so the post text keeps its room in a fixed-height week
          card; in a narrow column they wrap, and neither the time nor the status is cut. */}
      <span className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
        <span>{when(item.at, item.zone, CARD_TIME)}</span>
        <StatusWord status={item.status} />
      </span>
      {item.publishAt && new Date(item.publishAt).getTime() !== new Date(item.at).getTime() ? (
        <span className="block text-muted-foreground" data-testid="calendar-publish-at">
          publishes{' '}
          {when(item.publishAt, item.zone, {
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
          })}
        </span>
      ) : null}
      <strong className={weekly ? 'block truncate' : 'line-clamp-2 break-words'}>
        {sets.find((s) => s.id === item.setId)?.name ?? 'Account'}{' '}
        {prefs.platforms ? `· ${platformLabel(item.platform)}` : ''}
      </strong>
      <span className={prefs.density === 'compact' ? 'line-clamp-1' : 'line-clamp-3'}>
        {item.text || item.title || 'Untitled draft'}
      </span>
      {prefs.tags && item.tagIds.length > 0 ? (
        <span className="block truncate text-muted-foreground">
          {item.tagIds
            .map((id) => tags.find((t) => t.id === id)?.name)
            .filter(Boolean)
            .join(' · ')}
        </span>
      ) : null}
    </Button>
  )
  const dayCards = (day: string) => {
    const onDay = shown.filter((i) => itemDay(i) === day)
    const capped = prefs.view === 'month' && !prefs.showAll
    const open = openDays.includes(day)
    const { visible, hidden } = capped ? visibleDayItems(onDay) : { visible: onDay, hidden: 0 }
    return (
      <div className="grid gap-2">
        {/* Every view scrolls past four, so no day grows with its posts: an opened month
            day, or one full of posts that need attention, too. */}
        <DayList ids={(open ? onDay : visible).map((item) => item.id).join()}>
          {(open ? onDay : visible).map((item) => card(item))}
        </DayList>
        {hidden > 0 ? (
          <Button
            aria-expanded={open}
            className="h-auto justify-start px-1 py-0.5 text-xs font-normal text-muted-foreground"
            onClick={() =>
              setOpenDays((days) => (open ? days.filter((d) => d !== day) : [...days, day]))
            }
            size={null}
            variant="ghost"
          >
            {open ? 'Show less' : `+${hidden} more`}
          </Button>
        ) : null}
      </div>
    )
  }
  const slotsFor = (day: string, absolute = false) =>
    focused && prefs.slots
      ? brandDaySlots(
          day,
          focused.timeZone,
          focused.postingSlots,
          takenSlots(items, focused.id)
        ).map((slot) => {
          const [hour, minute] = slot.time.split(':').map(Number)
          const time = formatTimeOfDay(slot.time, twelveHour)
          return (
            <div
              key={slot.at}
              className={absolute ? 'absolute left-1 right-0' : 'mt-2'}
              style={absolute ? { top: hour * 60 + minute } : undefined}
            >
              <Button
                data-testid="available-slot"
                size={null}
                variant="custom"
                disabled={!canEdit}
                // The zone stays in the name and tooltip; in the cell it wrapped into the next day.
                aria-label={`Available · ${time} (${zoneLabel(focused.timeZone)})`}
                title={`Available · ${time} (${zoneLabel(focused.timeZone)})`}
                className="block h-auto w-full rounded border border-dashed p-2 text-xs font-normal break-words whitespace-normal text-muted-foreground"
                onClick={() => setCompose({ day, time: slot.time, setId: focused.id })}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setOver(null)
                  const id = event.dataTransfer.getData(DRAG)
                  const item = items.find((item) => item.id === id)
                  if (item) void mutate('move', [placement(item, slot.at)])
                  else {
                    const selected = sources?.find((draft) => draft.id === id)
                    if (selected)
                      setCompose({ day, time: slot.time, setId: focused.id, selected, source })
                  }
                }}
              >
                Available · {time}
                {focused.naturalPostingTimes ? ' ±4 min' : ''}
              </Button>
            </div>
          )
        })
      : null
  // A grid day and hour are read on the clock of the brand the draft is for.
  const create = (
    day: string,
    time = '12:00',
    from: { setId?: string; selected?: DraftWire; source?: 'drafts' | 'posted' } = {}
  ) => {
    const setId = from.setId || focused?.id || activeIds[0] || sets[0]?.id || ''
    setCompose({ ...from, day, time, setId })
  }
  return (
    <div className="flex h-full min-h-0 flex-col" inert={!hydrated} aria-busy={!hydrated}>
      <WorkspaceNav active="plan" />
      {sets[0] ? (
        <DraftSettingsDrawer
          advancedScheduling={advancedScheduling}
          canManage={canManageSets}
          socialSetId={focused?.id ?? sets[0].id}
        />
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside
          aria-label="Calendar accounts"
          className="max-h-72 w-full shrink-0 overflow-auto border-b p-3 md:max-h-none md:w-60 md:border-r"
        >
          {sidebar ? (
            <>
              <Button variant="ghost" onClick={() => setSidebar(null)}>
                <ArrowLeftIcon aria-hidden />
                Back to profiles
              </Button>
              <h2 className="my-2 font-medium">{sets.find((s) => s.id === sidebar)?.name}</h2>
              <div className="flex gap-2">
                {(['drafts', 'posted'] as const).map((tab) => (
                  <Button
                    size="sm"
                    variant={source === tab ? 'default' : 'outline'}
                    disabled={busy}
                    onClick={() => {
                      setSource(tab)
                    }}
                    key={tab}
                  >
                    {tab === 'drafts' ? 'Drafts' : 'Posted'}
                  </Button>
                ))}
              </div>
              <Input
                className="my-2 w-full"
                aria-label="Search sidebar drafts"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {sourceError ? (
                <p role="alert">
                  {sourceError}{' '}
                  <Button onClick={sourceList.retry} size="sm" variant="link">
                    Retry
                  </Button>
                </p>
              ) : sources === null ? (
                <p role="status">Loading drafts…</p>
              ) : sources.length === 0 ? (
                <p>No content found.</p>
              ) : (
                sources.map((d) => (
                  <Link
                    key={d.id}
                    draggable={canEdit}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG, d.id)
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                    href={`/publish/${d.id}`}
                    className="my-2 block rounded border p-2 text-xs"
                  >
                    <strong className="block">
                      {d.plainText.slice(0, 100) || d.title || 'Untitled draft'}
                    </strong>
                    {d.primaryPlatform} · Edited{' '}
                    {when(d.updatedAt, sets.find((s) => s.id === sidebar)?.timeZone, DAY_STYLE)}
                  </Link>
                ))
              )}
              {sourceList.hasMore ? (
                <Button disabled={sourceList.loading} onClick={sourceList.loadMore}>
                  Load more content
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Label className="mb-3">
                <Checkbox
                  aria-label="All profiles"
                  checked={
                    allState === 'all' ? true : allState === 'mixed' ? 'indeterminate' : false
                  }
                  onCheckedChange={() => setPref({ visible: allState === 'all' ? [] : null })}
                />
                All accounts
              </Label>
              {sets.map((set) => (
                <div key={set.id} className="mb-3 rounded border p-2">
                  <Label className="items-start font-normal">
                    <Checkbox
                      checked={activeIds.includes(set.id)}
                      aria-label={`Show ${set.name} ${set.accounts.map((a) => platformLabel(a.platform)).join(', ')}`}
                      onCheckedChange={() => setPref({ visible: toggle(activeIds, set.id) })}
                    />
                    <span>
                      <strong>{set.name}</strong>
                      <small className="block text-muted-foreground">
                        {set.accounts.map((a) => platformLabel(a.platform)).join(' · ') ||
                          'No connected accounts'}
                      </small>
                    </span>
                  </Label>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Button
                      className="h-7 px-1.5 text-xs"
                      onClick={() => setPref({ visible: [set.id] })}
                      size={null}
                      variant="ghost"
                    >
                      Show only
                    </Button>
                    <Button
                      onClick={() => setSidebar(set.id)}
                      className="h-7 px-1.5 text-xs"
                      size={null}
                      variant="ghost"
                    >
                      Drafts
                    </Button>
                    <Button
                      className="h-7 px-1.5 text-xs"
                      onClick={() => openBrandSettings('scheduling', set.id)}
                      size={null}
                      variant="ghost"
                    >
                      Settings
                    </Button>
                  </div>
                </div>
              ))}
              {focused ? (
                <Button variant="outline" size="sm" onClick={() => setPref({ visible: null })}>
                  Show all accounts
                </Button>
              ) : null}
              {!sets.length ? (
                <Button asChild variant="outline">
                  <Link href="/settings/publishing-brands">
                    Connect a social account to plan content
                  </Link>
                </Button>
              ) : null}
            </>
          )}
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <h1 className="mr-auto flex min-w-0 items-baseline gap-2 text-ui-lg font-semibold">
              Calendar{' '}
              <span className="truncate text-ui font-normal text-muted-foreground">
                {prefs.view === 'month'
                  ? readable(anchor, { month: 'long', year: 'numeric' })
                  : `${readable(days[0])} – ${readable(days.at(-1)!)}`}
              </span>
            </h1>
            {focused ? (
              <Button
                onClick={() => openBrandSettings('scheduling', focused.id)}
                size="sm"
                variant="outline"
              >
                <ClockIcon aria-hidden />
                Edit schedule
              </Button>
            ) : null}
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline">
                  <FunnelSimpleIcon aria-hidden />
                  Filters
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="grid w-64 gap-3 p-3">
                <fieldset>
                  <legend>Status</legend>
                  {STATUS_GROUPS.map((s) => (
                    <Label className="py-1 font-normal" key={s}>
                      <Checkbox
                        checked={prefs.statuses.includes(s)}
                        onCheckedChange={() => setPref({ statuses: toggle(prefs.statuses, s) })}
                      />
                      {s}
                    </Label>
                  ))}
                </fieldset>
                <fieldset>
                  <legend>Platform</legend>
                  {[
                    ...new Set(
                      sets
                        .filter((s) => activeIds.includes(s.id))
                        .flatMap((s) => s.accounts.map((a) => a.platform))
                    ),
                  ].map((p) => (
                    <Label className="py-1 font-normal" key={p}>
                      <Checkbox
                        checked={prefs.providers.includes(p)}
                        onCheckedChange={() => setPref({ providers: toggle(prefs.providers, p) })}
                      />
                      {platformLabel(p)}
                    </Label>
                  ))}
                </fieldset>
                <fieldset>
                  <legend>Tags</legend>
                  {tagsUnavailable ? (
                    <p role="status" className="text-xs">
                      Tags are unavailable for part of this scope. Enable tags in Settings or retry.{' '}
                      <Button
                        className="h-auto p-0 text-xs"
                        onClick={reload}
                        size={null}
                        variant="link"
                      >
                        Retry tags
                      </Button>
                    </p>
                  ) : !tags.length ? (
                    <p className="text-xs">No tags available.</p>
                  ) : null}
                  {tags.map((t) => (
                    <Label className="py-1 font-normal" key={t.id}>
                      <Checkbox
                        checked={prefs.tagIds.includes(t.id)}
                        onCheckedChange={() => setPref({ tagIds: toggle(prefs.tagIds, t.id) })}
                      />
                      {t.name}
                    </Label>
                  ))}
                </fieldset>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setPref({ statuses: [], providers: [], tagIds: [] })}
                >
                  Clear filters
                </Button>
              </PopoverContent>
            </Popover>
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline">
                  <SlidersHorizontalIcon aria-hidden />
                  Display
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="grid w-56 gap-3 p-3">
                <Label className="grid gap-1.5">
                  Density{' '}
                  <Select
                    value={prefs.density}
                    onValueChange={(value) =>
                      setPref({ density: value as PlanPreferences['density'] })
                    }
                  >
                    <SelectTrigger aria-label="Card density">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="expanded">Expanded</SelectItem>
                      <SelectItem value="compact">Compact</SelectItem>
                    </SelectContent>
                  </Select>
                </Label>
                <Label className="font-normal">
                  <Checkbox
                    checked={prefs.platforms}
                    onCheckedChange={(checked) => setPref({ platforms: checked === true })}
                  />
                  Show platforms
                </Label>
                <Label className="font-normal">
                  <Checkbox
                    checked={prefs.tags}
                    onCheckedChange={(checked) => setPref({ tags: checked === true })}
                  />
                  Show tags
                </Label>
                <Label className="grid gap-1.5">
                  Week starts{' '}
                  <Select
                    value={String(prefs.weekStart)}
                    onValueChange={(value) => setPref({ weekStart: Number(value) as 0 | 1 })}
                  >
                    <SelectTrigger aria-label="Week starts">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Sunday</SelectItem>
                      <SelectItem value="1">Monday</SelectItem>
                    </SelectContent>
                  </Select>
                </Label>
                {focused ? (
                  <Label className="font-normal">
                    <Checkbox
                      checked={prefs.slots}
                      onCheckedChange={(checked) => setPref({ slots: checked === true })}
                    />
                    Show empty slots
                  </Label>
                ) : null}
              </PopoverContent>
            </Popover>
            <Select
              disabled={!hydrated}
              value={prefs.view}
              onValueChange={(value) => setPref({ view: value as PlanPreferences['view'] })}
            >
              <SelectTrigger aria-label="Calendar view">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="flex">Flex</SelectItem>
                <SelectItem value="month">Month</SelectItem>
                <SelectItem value="week">Week</SelectItem>
              </SelectContent>
            </Select>
            {prefs.view === 'month' ? (
              <Button
                aria-pressed={prefs.showAll}
                // The month grid is hidden on a phone, where the queue lists every post.
                className="hidden md:inline-flex"
                onClick={() => setPref({ showAll: !prefs.showAll })}
                size="sm"
                variant={prefs.showAll ? 'default' : 'outline'}
              >
                {prefs.showAll ? 'Showing all posts' : 'Show all posts'}
              </Button>
            ) : null}
            {/* One joined control, as the period moves and returns to today together. */}
            <div
              aria-label="Change period"
              className="flex h-8 shrink-0 items-stretch rounded-md border border-border"
              role="group"
            >
              <Button
                aria-label={`Previous ${prefs.view === 'month' ? 'month' : 'period'}`}
                className="grid w-8 rounded-l-md place-items-center text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
                onClick={() => changePeriod(-1)}
                size={null}
                variant="custom"
              >
                <CaretLeftIcon aria-hidden className="size-4" />
              </Button>
              <Button
                className="border-x border-border px-3 text-ui font-medium transition-colors hover:bg-foreground/[0.04]"
                onClick={() => setAnchor(today)}
                size={null}
                variant="custom"
              >
                Today
              </Button>
              <Button
                aria-label={`Next ${prefs.view === 'month' ? 'month' : 'period'}`}
                className="grid w-8 rounded-r-md place-items-center text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
                onClick={() => changePeriod(1)}
                size={null}
                variant="custom"
              >
                <CaretRightIcon aria-hidden className="size-4" />
              </Button>
            </div>
          </header>
          {/* It floats over the grid: reserved room left an empty band whenever all was well. */}
          <div className="relative z-20 h-0 shrink-0">
            <div className="absolute inset-x-0 top-0 bg-background px-4 text-sm">
              {load === 'error' ? (
                <div role="alert" className="flex items-center gap-2">
                  {failure}{' '}
                  <Button variant="outline" size="sm" onClick={reload}>
                    Retry calendar
                  </Button>
                </div>
              ) : load === 'loading' ? (
                <p role="status" className="py-2">
                  Loading calendar…
                </p>
              ) : notesFailed ? (
                <div role="alert" className="flex items-center gap-2">
                  Notes could not load.{' '}
                  <Button variant="outline" size="sm" onClick={reload}>
                    Retry calendar
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
          <div ref={container} className="min-h-0 flex-1 overflow-auto" data-local-dropzone="">
            <div className="grid gap-3 p-3 md:hidden" aria-label="Mobile queue">
              {/* In date order, with a day's notes above its posts: a stable sort keeps them first. */}
              {[
                ...notes.map((note) => ({
                  day: note.day,
                  key: note.id,
                  node: (
                    <NoteChip
                      note={note}
                      onOpen={canEdit ? () => setNoteEdit({ day: note.day, note }) : undefined}
                    />
                  ),
                })),
                ...shown
                  .sort((a, b) => a.at.localeCompare(b.at))
                  .map((item) => ({
                    day: itemDay(item),
                    key: item.id,
                    node: card(item),
                  })),
              ]
                .sort((a, b) => a.day.localeCompare(b.day))
                .map(({ day, key, node }) => (
                  <div key={key}>
                    <p className="mb-1 text-sm">{readable(day)}</p>
                    {node}
                  </div>
                ))}
              {load === 'ready' && !shown.length ? <p>No content in this period.</p> : null}
              {canEdit ? <Button onClick={() => create(today)}>Plan a post</Button> : null}
            </div>
            <div
              className="hidden min-w-[644px] grid-cols-7 md:grid"
              aria-label={`${prefs.view} calendar`}
              style={
                prefs.view === 'week'
                  ? {
                      gridTemplateColumns: days
                        .map(
                          (day) =>
                            `minmax(${weekLayouts[day].lanes * 92}px, ${weekLayouts[day].lanes}fr)`
                        )
                        .join(' '),
                    }
                  : undefined
              }
            >
              {days.map((day) => (
                <section
                  key={day}
                  aria-label={readable(day, {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                  data-testid={`calendar-day-${Number(day.slice(8))}`}
                  data-calendar-date={day}
                  className={`@container relative min-w-0 border-b border-r p-1 ${prefs.view === 'week' ? '' : 'min-h-40'} ${day.slice(0, 7) !== anchor.slice(0, 7) && prefs.view === 'month' ? 'bg-muted/30' : ''} ${over === day ? 'bg-sky-500/10' : ''}`}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes(DRAG)) {
                      e.preventDefault()
                      setOver(day)
                    }
                  }}
                  onDragLeave={() => setOver(null)}
                  onDrop={(e) => drop(e, day)}
                >
                  {/* The buttons take a second row in a narrow column. A week's height is fixed:
                      neither that nor today's badge may push its hour grid below the others. */}
                  <div
                    className={`sticky top-0 z-10 flex flex-wrap items-center justify-between bg-background text-xs ${prefs.view === 'week' ? 'h-14 content-start' : 'min-h-8'}`}
                  >
                    <time
                      dateTime={day}
                      aria-current={day === today ? 'date' : undefined}
                      className={`whitespace-nowrap ${day === today ? 'rounded-full bg-sky-600 px-1.5 py-0.5 text-white' : ''}`}
                    >
                      {readable(
                        day,
                        day === days[0] || day.endsWith('-01')
                          ? { month: 'short', day: 'numeric' }
                          : { weekday: 'short', day: 'numeric' }
                      )}
                    </time>
                    <span className="flex shrink-0 items-center justify-end @max-[6.5rem]:w-full">
                      {prefs.view === 'week'
                        ? notes
                            .filter((note) => note.day === day)
                            .map((note) => (
                              <NoteChip
                                compact
                                key={note.id}
                                note={note}
                                onOpen={canEdit ? () => setNoteEdit({ day, note }) : undefined}
                              />
                            ))
                        : null}
                      {canEdit ? (
                        <Button
                          aria-label={`Add note ${day}`}
                          className="size-6"
                          onClick={() => setNoteEdit({ day })}
                          size="icon-sm"
                          title="Add note"
                          variant="ghost"
                        >
                          <NoteIcon aria-hidden />
                        </Button>
                      ) : null}
                      {canEdit && day >= today ? (
                        <Button
                          aria-label={`Create draft ${day}`}
                          className="size-6"
                          onClick={() => create(day)}
                          size="icon-sm"
                          variant="ghost"
                        >
                          <PlusIcon aria-hidden />
                        </Button>
                      ) : null}
                    </span>
                  </div>
                  {prefs.view === 'week' ? (
                    <div className="relative" style={{ height: 1440 + weekCardHeight }}>
                      {Array.from({ length: 24 }, (_, hour) => (
                        <div
                          key={hour}
                          className="absolute w-full border-t text-[10px] text-muted-foreground"
                          style={{ top: hour * 60, height: 60 }}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => drop(e, day, hour)}
                        >
                          <Button
                            className="h-auto px-1 py-0 text-[10px] font-normal text-muted-foreground"
                            disabled={!canEdit || day < today}
                            onClick={() => create(day, `${String(hour).padStart(2, '0')}:00`)}
                            size={null}
                            variant="ghost"
                          >
                            {formatTimeOfDay(`${String(hour).padStart(2, '0')}:00`, twelveHour)}
                          </Button>
                        </div>
                      ))}
                      {slotsFor(day, true)}
                      {weekLayouts[day].cards.map(({ item, top, lane }) => (
                        <div
                          className="absolute"
                          style={{
                            top,
                            left: `${(lane / weekLayouts[day].lanes) * 100}%`,
                            width: `calc(${100 / weekLayouts[day].lanes}% - 4px)`,
                            height: weekCardHeight,
                          }}
                          key={item.id}
                        >
                          {card(item, true)}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="grid gap-2">
                      {notes
                        .filter((note) => note.day === day)
                        .map((note) => (
                          <NoteChip
                            key={note.id}
                            note={note}
                            onOpen={canEdit ? () => setNoteEdit({ day, note }) : undefined}
                          />
                        ))}
                      {dayCards(day)}
                    </div>
                  )}
                  {prefs.view !== 'week' ? slotsFor(day) : null}
                </section>
              ))}
            </div>
          </div>
        </main>
      </div>
      {compose ? (
        <PlanComposer
          context={compose}
          sets={sets}
          canPublish={canPublish}
          onClose={() => setCompose(null)}
          onSaved={reload}
        />
      ) : null}
      {noteEdit ? (
        <NoteDialog
          day={noteEdit.day}
          dayLabel={readable(noteEdit.day, DAY_STYLE)}
          key={noteEdit.note?.id ?? noteEdit.day}
          note={noteEdit.note}
          onClose={() => setNoteEdit(null)}
          onSaved={reload}
        />
      ) : null}
      {detail ? (
        <PlanDetail
          item={detail}
          swapCandidates={
            advancedScheduling && canPublish
              ? items.filter(
                  (candidate) =>
                    candidate.id !== detail.id &&
                    candidate.setId === detail.setId &&
                    candidate.accountId === detail.accountId &&
                    candidate.status === 'Scheduled' &&
                    !candidate.campaignId
                )
              : []
          }
          sets={sets}
          canEdit={canEdit}
          canPublish={canPublish}
          onClose={() => setDetail(null)}
          onChange={reload}
          mutate={mutate}
          placement={placement}
        />
      ) : null}
    </div>
  )
}

/** A date and time on the brand's clock. It only asks about daylight saving at the hour the clocks repeat. */
function TimeFields({
  local,
  zone,
  choice,
  onLocal,
  onChoice,
  onValidityChange,
}: {
  local: string
  zone: string
  choice: 'earlier' | 'later'
  onLocal: (v: string) => void
  onChoice: (v: 'earlier' | 'later') => void
  onValidityChange: (valid: boolean) => void
}) {
  const when = useWhen()
  const resolved = localDateTimeSchema.safeParse(local).success
    ? resolveLocalTime(local, zone)
    : null
  return (
    <div className="grid gap-2">
      <Label className="grid gap-1.5">
        <span>
          Date and time{' '}
          <span className="font-normal text-muted-foreground" data-testid="schedule-zone">
            · {zoneLabel(zone)}
          </span>
        </span>
        <span className="grid grid-cols-2 gap-2">
          <DatePicker
            className="w-full"
            aria-label="Day"
            min={wallTime(new Date(), isTimeZone(zone) ? zone : 'UTC').slice(0, 10)}
            value={local.slice(0, 10)}
            onChange={(day) => onLocal(`${day}T${local.slice(11)}`)}
          />
          <TimePicker
            required
            onValidityChange={onValidityChange}
            className="w-full"
            aria-label="Time"
            value={local.slice(11)}
            onChange={(time) => onLocal(`${local.slice(0, 10)}T${time}`)}
          />
        </span>
      </Label>
      {resolved?.kind === 'ambiguous' ? (
        <Label className="grid gap-1.5">
          This time happens twice that day{' '}
          <Select value={choice} onValueChange={(value) => onChoice(value as typeof choice)}>
            <SelectTrigger aria-label="Repeated hour">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="earlier">First: {when(resolved.earlier, zone)}</SelectItem>
              <SelectItem value="later">Second: {when(resolved.later, zone)}</SelectItem>
            </SelectContent>
          </Select>
        </Label>
      ) : null}
    </div>
  )
}

function PlanComposer({
  context,
  sets,
  canPublish,
  onClose,
  onSaved,
}: {
  context: {
    day: string
    time: string
    setId: string
    selected?: DraftWire
    source?: 'drafts' | 'posted'
  }
  sets: SocialSetWire[]
  canPublish: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const router = useRouter()
  const when = useWhen()
  const [setId, setSetId] = React.useState(context.setId)
  const set = sets.find((s) => s.id === setId)
  const zone = set?.timeZone ?? 'UTC'
  const [body, setBody] = React.useState<Value>([{ type: 'p', children: [{ text: '' }] }])
  const [kind, setKind] = React.useState<'standard' | 'article'>('standard')
  const [title, setTitle] = React.useState('')
  const [timeValid, setTimeValid] = React.useState(true)
  const [local, setLocal] = React.useState(`${context.day}T${context.time}`)
  const [choice, setChoice] = React.useState<'earlier' | 'later'>('earlier')
  const [openEditor, setOpenEditor] = React.useState(true)
  const [picker, setPicker] = React.useState(Boolean(context.selected))
  const [source, setSource] = React.useState<'drafts' | 'posted'>(context.source ?? 'drafts')
  const [search, setSearch] = React.useState('')
  const sourceList = useDraftSources(picker ? setId : null, source, search)
  const results = sourceList.items
  const [selected, setSelected] = React.useState<DraftWire | null>(context.selected ?? null)
  const [tagIds, setTagIds] = React.useState<string[]>([])
  const [tags, setTags] = React.useState<DraftTagWire[] | null>(null)
  const [newTag, setNewTag] = React.useState('')
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const created = React.useRef<DraftWire | null>(null)
  const creationInput = React.useRef<Parameters<typeof draftsApi.create>[0] | null>(null)
  const reuseKey = React.useRef<string | null>(null)
  const planKey = React.useRef<string | null>(null)
  React.useEffect(() => {
    let active = true
    setTags(null)
    writeApi
      .tags(setId)
      .then((r) => {
        if (active) setTags(r.items)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [setId])
  const commit = async (schedule: boolean) => {
    if (busy || !timeValid) return
    setBusy(true)
    setError('')
    try {
      if (!set || !set.accounts.some((a) => a.health === 'connected'))
        throw new Error(
          'Choose a connected account. Reconnect it in Settings › Profiles if needed.'
        )
      const instant = selectedInstant(local, zone, choice)
      if (picker && !selected) throw new Error('Choose content first.')
      if (!picker && !draftPlainText(body).trim())
        throw new Error('Write some content before planning.')
      let draft = picker ? selected! : created.current
      if (picker && source === 'posted') {
        reuseKey.current ??= crypto.randomUUID()
        draft = created.current ?? (await writeApi.duplicate(selected!.id, reuseKey.current)).draft
        created.current = draft
      }
      if (!draft) {
        creationInput.current ??= {
          requestKey: crypto.randomUUID(),
          socialSetId: setId,
          body,
          plainText: draftPlainText(body),
          kind,
          tagIds,
          ...(kind === 'article' ? { article: { title } } : {}),
        }
        draft = await draftsApi.create(creationInput.current)
        created.current = draft
      }
      if (
        !picker &&
        (JSON.stringify(draft.body) !== JSON.stringify(body) ||
          (kind === 'article' && draft.article?.title !== title))
      ) {
        draft = await draftsApi.save(draft.id, {
          baseVersion: draft.version,
          body,
          plainText: draftPlainText(body),
          ...(kind === 'article' ? { article: { ...draft.article!, title } } : {}),
        })
        created.current = draft
      }
      if (
        !picker &&
        JSON.stringify(draft.tagIds.slice().sort()) !== JSON.stringify(tagIds.slice().sort())
      ) {
        draft = await writeApi.properties(draft.id, {
          addTagIds: tagIds.filter((id) => !draft!.tagIds.includes(id)),
          removeTagIds: draft.tagIds.filter((id) => !tagIds.includes(id)),
        })
        created.current = draft
      }
      if (schedule) {
        onClose()
        router.push(reviewScheduleHref(draft.id, instant, zone))
        return
      } else {
        planKey.current ??= crypto.randomUUID()
        const result = readWire(
          calendarResultSchema,
          await call('/api/v1/calendar/mutations', {
            method: 'POST',
            body: {
              key: planKey.current,
              action: 'move',
              items: [
                {
                  draftId: draft.id,
                  version: draft.version,
                  calendarVersion: draft.calendarVersion,
                  at: instant.toISOString(),
                  timeZone: zone,
                },
              ],
            },
          })
        )
        draft = result.drafts[0]
      }
      onSaved()
      onClose()
      toast.success(
        schedule ? 'Publication scheduled.' : 'Draft planned. It will not publish automatically.'
      )
      if (openEditor) router.push(`/publish/${draft.id}`)
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not save. Retry without closing this composer.'
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{picker ? 'Choose a draft' : 'Plan a draft'}</DialogTitle>
          <DialogDescription>
            Choose content and a date. Planning does not authorize publication.
          </DialogDescription>
        </DialogHeader>
        <Label className="grid gap-1.5">
          Social account{' '}
          <Select
            value={setId}
            disabled={
              busy ||
              creationInput.current !== null ||
              reuseKey.current !== null ||
              created.current !== null
            }
            onValueChange={(value) => {
              setSetId(value)
              setTagIds([])
              setSelected(null)
              setKind('standard')
            }}
          >
            <SelectTrigger aria-label="Composer social account" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sets.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name} · {s.accounts.map((a) => platformLabel(a.platform)).join(', ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Label>
        <Button
          variant="outline"
          disabled={busy || creationInput.current !== null || created.current !== null}
          onClick={() => {
            setPicker(!picker)
            setSelected(null)
            setError('')
          }}
        >
          {picker ? 'Back to composer' : 'Choose existing content'}
        </Button>
        {picker ? (
          <>
            <div className="flex gap-2">
              {(['drafts', 'posted'] as const).map((tab) => (
                <Button
                  key={tab}
                  variant={tab === source ? 'default' : 'outline'}
                  disabled={
                    busy ||
                    creationInput.current !== null ||
                    reuseKey.current !== null ||
                    created.current !== null
                  }
                  onClick={() => {
                    setSource(tab)
                    setSelected(null)
                  }}
                >
                  {tab === 'posted' ? 'Published' : 'Drafts'}
                </Button>
              ))}
            </div>
            <Input
              placeholder="Search content"
              aria-label="Search existing content"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {sourceList.error ? (
              <p role="alert">
                {sourceList.error}{' '}
                <Button onClick={sourceList.retry} size="sm" variant="link">
                  Retry sources
                </Button>
              </p>
            ) : null}
            <div className="max-h-48 overflow-auto">
              {results === null ? (
                <p role="status">Loading content…</p>
              ) : results.length === 0 ? (
                <p>No content matches.</p>
              ) : (
                results.map((d) => (
                  <Button
                    type="button"
                    size={null}
                    variant="custom"
                    aria-pressed={selected?.id === d.id}
                    key={d.id}
                    className="mb-2 block h-auto w-full rounded border p-2 text-left text-sm font-normal whitespace-normal aria-pressed:border-sky-500"
                    disabled={
                      busy ||
                      creationInput.current !== null ||
                      reuseKey.current !== null ||
                      created.current !== null
                    }
                    onClick={() => setSelected(d)}
                  >
                    {d.plainText.slice(0, 130) || d.title || 'Untitled draft'}
                    <small className="block">
                      {set?.name} · {d.primaryPlatform} · Edited {when(d.updatedAt, zone)}
                    </small>
                  </Button>
                ))
              )}
            </div>
            {sourceList.hasMore ? (
              <Button disabled={sourceList.loading} onClick={sourceList.loadMore}>
                Load more content
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <Label className="grid gap-1.5">
              Post type{' '}
              <Select
                value={kind}
                disabled={busy || creationInput.current !== null}
                onValueChange={(value) => setKind(value as typeof kind)}
              >
                <SelectTrigger aria-label="Post type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">Post or thread</SelectItem>
                  {set?.accounts.some((a) => channelForPlatform(a.platform) === 'x') ? (
                    <SelectItem value="article">X Article</SelectItem>
                  ) : null}
                </SelectContent>
              </Select>
            </Label>
            {kind === 'article' ? (
              <Input
                aria-label="Article title"
                placeholder="Article title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            ) : null}
            <QuickBody value={body} onChange={setBody} />
            <fieldset>
              <legend>Tags</legend>
              {tags === null ? (
                <p className="text-xs">Tags unavailable. Enable draft tags in Settings.</p>
              ) : !tags.length ? (
                <p className="text-xs">No tags in this profile.</p>
              ) : (
                tags.map((t) => (
                  <Label className="mr-3 inline-flex py-1 font-normal" key={t.id}>
                    <Checkbox
                      checked={tagIds.includes(t.id)}
                      onCheckedChange={() => setTagIds(toggle(tagIds, t.id))}
                    />
                    {t.name}
                  </Label>
                ))
              )}
              {tags !== null ? (
                <div className="mt-2 flex gap-2">
                  <Input
                    aria-label="New tag name"
                    value={newTag}
                    maxLength={40}
                    onChange={(event) => setNewTag(event.target.value)}
                    placeholder="New tag"
                  />
                  <Button
                    variant="outline"
                    disabled={busy || !newTag.trim()}
                    onClick={async () => {
                      setBusy(true)
                      try {
                        const tag = await writeApi.createTag(setId, { name: newTag.trim() })
                        setTags((existing) => [...(existing ?? []), tag])
                        setTagIds((ids) => [...ids, tag.id])
                        setNewTag('')
                      } catch (error) {
                        setError((error as Error).message)
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    Add tag
                  </Button>
                </div>
              ) : null}
            </fieldset>
          </>
        )}
        <TimeFields
          local={local}
          zone={zone}
          choice={choice}
          onLocal={setLocal}
          onChoice={setChoice}
          onValidityChange={setTimeValid}
        />
        <Label className="font-normal">
          <Checkbox
            checked={openEditor}
            onCheckedChange={(checked) => setOpenEditor(checked === true)}
          />
          Open in editor
        </Label>
        {error ? (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (picker && !created.current) {
                setPicker(false)
                setSelected(null)
              } else onClose()
            }}
          >
            Close
          </Button>
          <Button
            disabled={busy || !timeValid || (picker && !selected)}
            onClick={() => void commit(false)}
          >
            {picker ? 'Plan' : 'Plan draft'}
          </Button>
          {picker ? (
            <Button
              disabled={busy || !timeValid || !selected || !canPublish}
              title={!canPublish ? 'Publishing permission required.' : undefined}
              onClick={() => void commit(true)}
            >
              Review and schedule…
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Scheduling from Plan opens the draft's own review (ScheduleDialog) at the
 * chosen instant, read in the brand's zone, so every schedule is confirmed
 * with its destinations, content, zone and checks in one place.
 */
function reviewScheduleHref(draftId: string, at: Date, zone: string): string {
  const wall = wallTime(at, zone)
  return `/publish/${draftId}?${new URLSearchParams({ panel: 'schedule', day: wall.slice(0, 10), time: wall.slice(11) })}`
}

function PlanDetail({
  item,
  swapCandidates,
  sets,
  canEdit,
  canPublish,
  onClose,
  onChange,
  mutate,
  placement,
}: {
  item: PlanItem
  swapCandidates: PlanItem[]
  sets: SocialSetWire[]
  canEdit: boolean
  canPublish: boolean
  onClose: () => void
  onChange: () => void
  mutate: (
    action: 'move' | 'swap' | 'unschedule' | 'remove_date',
    items: CalendarPlacement[]
  ) => Promise<void>
  placement: (item: PlanItem, at: string | null) => CalendarPlacement
}) {
  const [draft, setDraft] = React.useState<DraftWire | null>(null)
  const [revisionCount, setRevisionCount] = React.useState<number | null>(null)
  const [timeValid, setTimeValid] = React.useState(true)
  const [local, setLocal] = React.useState(wallTime(new Date(item.at), item.zone))
  const router = useRouter()
  const when = useWhen()
  const [choice, setChoice] = React.useState(occurrence(item.at, item.zone))
  const [reload, setReload] = React.useState(0)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [copySet, setCopySet] = React.useState(item.setId)
  const [receipts, setReceipts] = React.useState<DraftPostWire[]>([])
  const [detailTags, setDetailTags] = React.useState<DraftTagWire[] | null>(null)
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      onChange()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  React.useEffect(() => {
    let active = true
    draftsApi
      .posts(item.draftId)
      .then((r) => {
        if (active) setReceipts(r.posts)
      })
      .catch((e) => {
        if (active) setError(e.message)
      })
    writeApi
      .tags(item.setId)
      .then((r) => {
        if (active) setDetailTags(r.items)
      })
      .catch(() => {})
    setError('')
    Promise.allSettled([draftsApi.get(item.draftId), draftsApi.revisions(item.draftId)]).then(([d, r]) => {
      if (!active) return
      if (d.status === 'fulfilled') setDraft(d.value)
      if (r.status === 'fulfilled') setRevisionCount(r.value.items.length)
      const failure = [d, r].find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') setError(failure.reason.message)
    })
    return () => {
      active = false
    }
  }, [item.draftId, item.setId, reload])
  const set = sets.find((s) => s.id === item.setId)
  // A calendar unschedule returns the draft to a plan, so it cancels all of these.
  const queued = receipts.filter((post) => post.status === 'SCHEDULED')
  // A failure a newer attempt replaced is history: retrying it could post twice.
  const current = currentPosts(receipts)
  const publishAt = item.publishAt ?? item.at
  const offSlot = new Date(publishAt).getTime() !== new Date(item.at).getTime()
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <SheetContent className="overflow-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{item.title || 'Content details'}</SheetTitle>
          <SheetDescription>
            {set?.name} · {platformLabel(item.platform)} · {item.status}
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-4 p-4">
          <p className="whitespace-pre-wrap text-sm">{item.text}</p>
          <p className="text-xs">
            {item.postId ? (
              <>
                Scheduled for{' '}
                {when(
                  publishAt,
                  item.zone,
                  offSlot ? { ...WHEN_STYLE, second: '2-digit' } : WHEN_STYLE
                )}
                {offSlot ? ` · Queue slot: ${when(item.at, item.zone)}` : ''}
              </>
            ) : (
              <>Planned for {when(item.at, item.zone)}. Planning never publishes.</>
            )}
          </p>
          {['Failed', 'Needs check', 'Cancelled'].includes(item.status) &&
          postFailureReason(item.failureCode) ? (
            <p className="text-xs text-red-700 dark:text-red-300" role="status">
              {postFailureReason(item.failureCode)}
            </p>
          ) : null}
          {item.url ? (
            <Button asChild className="h-auto justify-start p-0" size={null} variant="link">
              <a href={item.url} rel="noreferrer" target="_blank">
                View published post
              </a>
            </Button>
          ) : null}
          <Button asChild className="h-auto justify-start p-0" size={null} variant="link">
            <Link href={`/publish/${item.draftId}`}>Open in editor</Link>
          </Button>
          <TimeFields
            local={local}
            zone={item.zone}
            choice={choice}
            onLocal={setLocal}
            onChoice={setChoice}
            onValidityChange={setTimeValid}
          />
          {item.deliveryStatus === 'SCHEDULED' && swapCandidates.length > 0 ? (
            <Label className="grid gap-1.5">
              Swap queue position
              <Select
                disabled={busy || !canPublish}
                value=""
                onValueChange={(value) => {
                  const other = swapCandidates.find((candidate) => candidate.id === value)
                  if (other)
                    void run(() =>
                      mutate('swap', [placement(item, other.at), placement(other, item.at)])
                    )
                }}
              >
                <SelectTrigger aria-label={`Swap queue position for ${item.text || item.title}`}>
                  <SelectValue placeholder="Choose a scheduled post…" />
                </SelectTrigger>
                <SelectContent>
                  {swapCandidates.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.text || candidate.title} · {when(candidate.at, candidate.zone)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                busy ||
                !timeValid ||
                (item.status === 'Planned' ? !canEdit : !canPublish) ||
                !['Planned', 'Scheduled', 'Overdue'].includes(item.status)
              }
              onClick={() =>
                void run(async () => {
                  if (!timeValid) return
                  const at = selectedInstant(local, item.zone, choice)
                  await mutate('move', [placement(item, at.toISOString())])
                })
              }
            >
              {item.postId && queued.length > 1
                ? `Move this ${platformLabel(item.platform)} post`
                : 'Move'}
            </Button>
            {item.status === 'Planned' ? (
              <>
                <Button
                  disabled={busy || !canPublish}
                  onClick={() =>
                    void run(async () => {
                      if (!timeValid) return
                      const at = selectedInstant(local, item.zone, choice)
                      onClose()
                      router.push(reviewScheduleHref(item.draftId, at, item.zone))
                    })
                  }
                >
                  Review and schedule…
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !canEdit}
                  onClick={() => void mutate('remove_date', [placement(item, null)])}
                >
                  Remove date
                </Button>
              </>
            ) : null}
            {['Scheduled', 'Overdue'].includes(item.status) ? (
              <Button
                variant="outline"
                disabled={busy || !canPublish}
                onClick={() => void mutate('unschedule', [placement(item, item.at)])}
              >
                {queued.length > 1 ? `Unschedule all ${queued.length} destinations` : 'Unschedule'}
              </Button>
            ) : null}
          </div>
          {item.postId && queued.length > 1 ? (
            <p className="text-xs text-muted-foreground" data-testid="unschedule-scope">
              Move changes only this {platformLabel(item.platform)} post. Unschedule returns the
              whole draft to a plan and cancels every queued destination:{' '}
              {queued.map((post) => platformLabel(post.platform)).join(', ')}. To stop one
              destination only, cancel it from the draft’s posts in the editor.
            </p>
          ) : null}
          {!canEdit ? (
            <p className="text-sm">Your role can view content. Editing requires an editor role.</p>
          ) : !canPublish ? (
            <p className="text-sm">
              Planning is available. Scheduling and unscheduling require publishing permission.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!canEdit || busy}
              onClick={() =>
                void run(async () => {
                  await writeApi.duplicate(item.draftId)
                  toast.success('A new undated draft was created.')
                })
              }
            >
              Duplicate
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                void navigator.clipboard
                  .writeText(item.text)
                  .then(() => toast.success('Content copied.'))
                  .catch(() => setError('Clipboard unavailable. Select and copy the preview.'))
              }
            >
              Copy text
            </Button>
          </div>
          <Label className="grid gap-1.5">
            Copy to profile{' '}
            <Select value={copySet} onValueChange={(value) => setCopySet(value)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sets.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} · {s.accounts.map((a) => platformLabel(a.platform)).join(', ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Label>
          <Button
            variant="outline"
            disabled={!canEdit || busy}
            onClick={() =>
              void run(async () => {
                await writeApi.copy(item.draftId, { socialSetId: copySet, tagMode: 'match' })
                toast.success('Content copied to a new draft.')
              })
            }
          >
            Create copy
          </Button>
          <fieldset className="grid gap-2">
            <legend>Tags</legend>
            {detailTags === null ? (
              <p className="text-xs">Tags unavailable. Enable draft tags in Settings.</p>
            ) : detailTags.length === 0 ? (
              <p className="text-xs">No tags in this profile.</p>
            ) : (
              detailTags.map((tag) => (
                <Label key={tag.id} className="font-normal">
                  <Checkbox
                    disabled={!canEdit || busy || !draft}
                    checked={draft?.tagIds.includes(tag.id) ?? false}
                    onCheckedChange={(value) => {
                      const checked = value === true
                      void run(async () => {
                        const updated = await writeApi.properties(
                          item.draftId,
                          checked ? { addTagIds: [tag.id] } : { removeTagIds: [tag.id] }
                        )
                        setDraft(updated)
                      })
                    }}
                  />
                  {tag.name}
                </Label>
              ))
            )}
          </fieldset>
          <section aria-label="Publication results">
            <h3 className="text-ui-lg font-medium">Publication results</h3>
            {receipts.length === 0 ? (
              <p className="text-xs">No publication commitment or provider receipt.</p>
            ) : (
              receipts.map((post) => (
                <div key={post.id} className="my-2 grid gap-1 rounded border p-2 text-xs">
                  <p className="flex flex-wrap items-center gap-1.5">
                    <span className="text-foreground">{platformLabel(post.platform)}</span>
                    <Pill tone={POST_STATE_TONE[postState(post.status, post.scheduledFor)]}>
                      {postState(post.status, post.scheduledFor)}
                    </Pill>
                    <span className="text-muted-foreground">
                      {when(post.scheduledFor, item.zone)}
                    </span>
                  </p>
                  {postFailureReason(post.failureCode) ? (
                    <p className="text-muted-foreground">{postFailureReason(post.failureCode)}</p>
                  ) : null}
                  {post.url ? (
                    <Button asChild className="h-auto p-0 text-xs" size={null} variant="link">
                      <a href={post.url} target="_blank" rel="noreferrer">
                        Provider receipt
                      </a>
                    </Button>
                  ) : null}
                  {post.threadProgress.total > 0 ? (
                    <p>
                      {post.threadProgress.posted} of {post.threadProgress.total} continuation posts
                      published.
                    </p>
                  ) : null}
                  {post.status === 'FAILED' && !current.includes(post) ? (
                    <p>A newer attempt to this account replaced this one.</p>
                  ) : null}
                  {post.status === 'FAILED' && current.includes(post) ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canPublish || busy}
                      onClick={() =>
                        void run(async () => {
                          await writeApi.retryPost(post.id)
                          onClose()
                        })
                      }
                    >
                      Retry failed destination
                    </Button>
                  ) : null}
                  {post.status === 'SENT_TO_APP' ? (
                    <p>
                      Sent to the {platformLabel(post.platform)} app as a draft. Finish and post it
                      there.
                    </p>
                  ) : null}
                  {post.status === 'UNKNOWN_DELIVERY' ? (
                    <p>
                      Check the live provider result before retrying. Open the editor to reconcile
                      this destination.
                    </p>
                  ) : null}
                </div>
              ))
            )}
          </section>
          <Accordion type="single" collapsible>
            <AccordionItem value="activity">
              <AccordionTrigger>Activity and revisions ({revisionCount ?? '…'})</AccordionTrigger>
              <AccordionContent>
                {draft?.id === item.draftId ? (
                  <DraftHistory draftId={draft.id} key={draft.id} version={draft.version} />
                ) : null}
                <Button asChild className="h-auto p-0" size={null} variant="link">
                  <Link href={`/publish/${item.draftId}?panel=backups`}>
                    Browse revisions in editor
                  </Link>
                </Button>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
          <Disclosure>
            <DisclosureTrigger className="text-sm font-medium">Details</DisclosureTrigger>
            <DisclosureContent className="grid gap-2 pt-2 text-xs text-muted-foreground">
              {draft ? (
                <p>
                  Content version {draft.version} · {draft.tagIds.length} tags · Review:{' '}
                  {draft.reviewStatus}
                </p>
              ) : (
                <p role="status">Loading details…</p>
              )}
              <p>Today: {when(new Date(), item.zone, DAY_STYLE)}. Any minute is supported.</p>
              <Label className="grid gap-1 font-normal">
                Exact time in UTC
                <Input
                  className="font-mono text-xs"
                  onFocus={(event) => event.currentTarget.select()}
                  readOnly
                  value={new Date(publishAt).toISOString()}
                />
              </Label>
            </DisclosureContent>
          </Disclosure>
          {confirmDelete ? (
            <div role="alert">
              <p>Delete this draft? Published provider posts remain on their networks.</p>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await draftsApi.remove(item.draftId, {
                      version: item.version,
                      calendarVersion: item.calendarVersion,
                    })
                    onClose()
                  })
                }
              >
                Confirm deletion
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              disabled={!canEdit || busy}
              onClick={() => setConfirmDelete(true)}
            >
              Delete draft
            </Button>
          )}
          {error ? (
            <p role="alert" className="text-sm text-red-600">
              {error}{' '}
              <Button onClick={() => setReload((value) => value + 1)} size="sm" variant="link">
                Retry details
              </Button>
            </p>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
