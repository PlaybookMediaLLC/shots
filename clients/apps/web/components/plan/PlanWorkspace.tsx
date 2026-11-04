'use client'

import * as React from 'react'
import { readWire } from '@/lib/plan/wire'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import type { Value } from '@shots/platejs-editor/platejs'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { Pill } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DatePicker } from '@/components/ui/date-picker'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
import { calendarResultSchema, type CalendarPlacement } from '@/lib/api/contracts/plan-analyze'
import { call, draftsApi, type DraftWire, type DraftPostWire } from '@/lib/content-drafts/client'
import {
  currentPosts,
  POST_STATE_TONE,
  postFailureReason,
  postState,
  STATUS_GROUPS,
} from '@/lib/content-drafts/post-status'
import { draftPlainText, channelForPlatform } from '@/lib/content-drafts/serialize'
import {
  writeApi,
  type SocialSetWire,
  type DraftTagWire,
  type DraftActivityWire,
} from '@/lib/write/client'
import { wallTime, isTimeZone, resolveLocalTime } from '@/lib/write/zoned-time'
import { addDays, zonedDayKey, zonedInstant } from '@/lib/settings/zoned-time'
import {
  calendarDays,
  displayDaySlots,
  itemDay,
  planPreferencesSchema,
  movedToDay,
  selectedInstant,
  takenSlots,
  selectionState,
  shiftAnchor,
  validDay,
  visibleItems,
  weekCardLayout,
  type PlanItem,
  type PlanPreferences,
} from '@/lib/plan/calendar'
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

/** Plan uses the existing drafts and publishing APIs, with independent personal view state. */
export function PlanWorkspace({
  sets,
  canEdit,
  canPublish,
  preferenceKey,
  initialZone,
  initialWeekStart,
  initialDay,
  initialView,
  advancedScheduling = false,
  campaignsEnabled = false,
}: {
  sets: SocialSetWire[]
  canEdit: boolean
  canPublish: boolean
  preferenceKey: string
  initialZone: string
  initialWeekStart: 0 | 1
  initialDay?: string
  initialView?: string
  advancedScheduling?: boolean
  /** Campaigns are usable here, so Publish lists Campaign deliveries. */
  campaignsEnabled?: boolean
}) {
  const router = useRouter()
  const [prefs, setPrefs] = React.useState<PlanPreferences>(() =>
    planPreferencesSchema.parse({
      zone: initialZone,
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
    zone?: string
    selected?: DraftWire
    source?: 'drafts' | 'posted'
  } | null>(null)
  const [detail, setDetail] = React.useState<PlanItem | null>(null)
  const [over, setOver] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const activeIds = prefs.visible ?? sets.map((s) => s.id)
  const focused = activeIds.length === 1 ? sets.find((s) => s.id === activeIds[0]) : undefined
  const days = calendarDays(anchor, prefs.view, prefs.weekStart, weeks)
  const rangeKey = `${days[0]}:${days.at(-1)}:${prefs.zone}`
  const today = zonedDayKey(new Date(), prefs.zone)
  const shown = visibleItems(items, prefs)
  const weekCardHeight = prefs.density === 'compact' ? 88 : 120
  const weekLayouts = Object.fromEntries(
    prefs.view === 'week'
      ? days.map((day) => [
          day,
          weekCardLayout(
            shown.filter((item) => itemDay(item, prefs.zone) === day),
            prefs.zone,
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
    const [start, end, zone] = rangeKey.split(':')
    // IANA zones contain slashes, not colons; stored instants never change with this preference.
    const query = new URLSearchParams({
      from: zonedInstant(start, 0, 0, zone).toISOString(),
      to: zonedInstant(addDays(end, 1), 0, 0, zone).toISOString(),
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
            at: p.slotAt ?? p.scheduledFor,
            publishAt: p.scheduledFor,
            zone: p.scheduleTimeZone ?? 'UTC',
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
              zone: d.planTimeZone ?? 'UTC',
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
    { key: 'escape', label: 'Back to publishing brands', run: () => setSidebar(null) },
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
      // A day keeps the post's own clock; a week hour is the one picked in this display.
      const at =
        hour === undefined
          ? movedToDay(item.at, item.zone, prefs.zone, day)
          : selectedInstant(`${day}T${String(hour).padStart(2, '0')}:00`, prefs.zone, 'reject')
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
      aria-label={`${item.status}: ${item.text || item.title}, ${sets.find((s) => s.id === item.setId)?.name ?? 'Account'}, ${item.platform}`}
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
      onDrop={(e) => drop(e, itemDay(item, prefs.zone), undefined, item)}
      onClick={() =>
        item.campaignId ? router.push(`/campaigns/${item.campaignId}`) : setDetail(item)
      }
      className={`block h-auto w-full min-w-0 rounded-lg border p-2 text-left text-xs font-normal whitespace-normal shadow-sm ${weekly ? 'h-full overflow-hidden' : ''} ${item.status === 'Planned' ? 'border-dashed border-violet-400' : item.status === 'Published' ? 'border-emerald-500' : item.status === 'Failed' ? 'border-red-500' : item.status === 'Needs check' || item.status === 'Overdue' ? 'border-amber-500' : 'border-sky-500'} bg-background`}
    >
      {/* One line, so the post text keeps its room in a fixed-height week card: the
          time stays whole and the status gives way first. */}
      <span className="block truncate text-muted-foreground">
        <span className="whitespace-nowrap">
          {new Date(item.at).toLocaleTimeString(undefined, {
            hour: 'numeric',
            minute: '2-digit',
            timeZone: prefs.zone,
          })}
        </span>{' '}
        · {item.status}
      </span>
      {item.publishAt && new Date(item.publishAt).getTime() !== new Date(item.at).getTime() ? (
        <span className="block truncate text-muted-foreground" data-testid="calendar-publish-at">
          publishes{' '}
          {new Date(item.publishAt).toLocaleTimeString(undefined, {
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
            timeZone: prefs.zone,
          })}
        </span>
      ) : null}
      <strong className={weekly ? 'block truncate' : 'line-clamp-2 break-words'}>
        {sets.find((s) => s.id === item.setId)?.name ?? 'Account'}{' '}
        {prefs.platforms ? `· ${item.platform}` : ''}
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
  const slotsFor = (day: string, absolute = false) =>
    focused && prefs.slots
      ? displayDaySlots(
          day,
          prefs.zone,
          focused.timeZone,
          focused.postingSlots,
          takenSlots(items, focused.id)
        ).map((slot) => {
          const [hour, minute] = slot.displayTime.split(':').map(Number)
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
                aria-label={`Available · ${slot.displayTime} (${prefs.zone})`}
                title={`Available · ${slot.displayTime} (${prefs.zone})`}
                className="block h-auto w-full rounded border border-dashed p-2 text-xs font-normal break-words whitespace-normal text-muted-foreground"
                onClick={() =>
                  setCompose({
                    day: slot.localDay,
                    time: slot.localTime,
                    setId: focused.id,
                    zone: focused.timeZone,
                  })
                }
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
                      setCompose({
                        day: slot.localDay,
                        time: slot.localTime,
                        setId: focused.id,
                        zone: focused.timeZone,
                        selected,
                        source,
                      })
                  }
                }}
              >
                Available · {slot.displayTime}
              </Button>
              <Link
                className="block text-right text-[10px] text-muted-foreground underline"
                href={`/write/settings?set=${focused.id}`}
              >
                Edit schedule
              </Link>
            </div>
          )
        })
      : null
  // A grid day and hour are read in the display zone, then composed in the brand's zone.
  const create = (
    day: string,
    time = '12:00',
    from: { setId?: string; selected?: DraftWire; source?: 'drafts' | 'posted' } = {}
  ) => {
    const setId = from.setId || focused?.id || activeIds[0] || sets[0]?.id || ''
    const scheduleZone = sets.find((set) => set.id === setId)?.timeZone ?? prefs.zone
    const resolved = resolveLocalTime(`${day}T${time}`, prefs.zone)
    if (resolved.kind !== 'exact') {
      // Keep the explicit display-zone occurrence selector for ambiguous grid hours.
      setCompose({ ...from, day, time, setId, zone: prefs.zone })
      return
    }
    const local = wallTime(resolved.at, scheduleZone)
    setCompose({
      ...from,
      day: local.slice(0, 10),
      time: local.slice(11),
      setId,
      zone: scheduleZone,
    })
  }
  return (
    <div className="flex h-full min-h-0 flex-col" inert={!hydrated} aria-busy={!hydrated}>
      <WorkspaceNav active="plan" campaigns={campaignsEnabled} />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside
          aria-label="Calendar accounts"
          className="max-h-72 w-full shrink-0 overflow-auto border-b p-3 md:max-h-none md:w-60 md:border-r"
        >
          {sidebar ? (
            <>
              <Button variant="ghost" onClick={() => setSidebar(null)}>
                ← Back to publishing brands
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
                    href={`/write/${d.id}`}
                    className="my-2 block rounded border p-2 text-xs"
                  >
                    <strong className="block">
                      {d.plainText.slice(0, 100) || d.title || 'Untitled draft'}
                    </strong>
                    {d.primaryPlatform} · Edited {new Date(d.updatedAt).toLocaleDateString()}
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
                  aria-label="All publishing brands"
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
                      aria-label={`Show ${set.name} ${set.accounts.map((a) => a.platform).join(', ')}`}
                      onCheckedChange={() => setPref({ visible: toggle(activeIds, set.id) })}
                    />
                    <span>
                      <strong>{set.name}</strong>
                      <small className="block text-muted-foreground">
                        {set.accounts.map((a) => a.platform).join(' · ') || 'No connected accounts'}
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
                    <Button asChild className="h-7 px-1.5 text-xs" size={null} variant="ghost">
                      <Link href={`/write/settings?set=${set.id}`}>Settings</Link>
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
                  <Link href="/workspace/social-sets">
                    Connect a social account to plan content
                  </Link>
                </Button>
              ) : null}
            </>
          )}
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex flex-wrap items-center gap-2 border-b p-3">
            <h1 className="mr-auto font-semibold">
              {prefs.view === 'month'
                ? readable(anchor, { month: 'long', year: 'numeric' })
                : `${readable(days[0])} – ${readable(days.at(-1)!)}`}
            </h1>
            <Label className="text-xs font-normal text-muted-foreground">
              Display timezone
              <Input
                aria-label="Display timezone"
                className="h-8 w-48 text-foreground"
                list="plan-zones"
                defaultValue={prefs.zone}
                key={prefs.zone}
                onBlur={(e) => {
                  if (isTimeZone(e.target.value)) setPref({ zone: e.target.value })
                  else {
                    e.target.value = prefs.zone
                    toast.error('Choose a valid IANA timezone.')
                  }
                }}
              />
            </Label>
            <datalist id="plan-zones">
              {[
                ...new Set([
                  'UTC',
                  'America/New_York',
                  'Europe/London',
                  'Asia/Tokyo',
                  ...sets.map((s) => s.timeZone),
                ]),
              ].map((z) => (
                <NativeSelectOption key={z}>{z}</NativeSelectOption>
              ))}
            </datalist>
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline">
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
                      {p}
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
                  Display
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="grid w-56 gap-3 p-3">
                <Label className="grid gap-1.5">
                  Density{' '}
                  <NativeSelect
                    aria-label="Card density"
                    value={prefs.density}
                    onChange={(e) =>
                      setPref({ density: e.target.value as PlanPreferences['density'] })
                    }
                  >
                    <NativeSelectOption value="expanded">Expanded</NativeSelectOption>
                    <NativeSelectOption value="compact">Compact</NativeSelectOption>
                  </NativeSelect>
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
                  <NativeSelect
                    aria-label="Week starts"
                    value={prefs.weekStart}
                    onChange={(e) => setPref({ weekStart: Number(e.target.value) as 0 | 1 })}
                  >
                    <NativeSelectOption value="0">Sunday</NativeSelectOption>
                    <NativeSelectOption value="1">Monday</NativeSelectOption>
                  </NativeSelect>
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
            <NativeSelect
              aria-label="Calendar view"
              disabled={!hydrated}
              value={prefs.view}
              onChange={(e) => setPref({ view: e.target.value as PlanPreferences['view'] })}
            >
              <NativeSelectOption value="flex">Flex</NativeSelectOption>
              <NativeSelectOption value="month">Month</NativeSelectOption>
              <NativeSelectOption value="week">Week</NativeSelectOption>
            </NativeSelect>
            <Button
              variant="outline"
              size="sm"
              aria-label={`Previous ${prefs.view === 'month' ? 'month' : 'period'}`}
              onClick={() => changePeriod(-1)}
            >
              ←
            </Button>
            <Button variant="outline" size="sm" onClick={() => setAnchor(today)}>
              Today
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label={`Next ${prefs.view === 'month' ? 'month' : 'period'}`}
              onClick={() => changePeriod(1)}
            >
              →
            </Button>
          </header>
          {/* Keep the measured Flex viewport stable while a range loads or fails. */}
          <div className="h-10 shrink-0 overflow-y-auto px-4 text-sm">
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
            ) : null}
          </div>
          <div ref={container} className="min-h-0 flex-1 overflow-auto" data-local-dropzone="">
            <div className="grid gap-3 p-3 md:hidden" aria-label="Mobile queue">
              {shown
                .sort((a, b) => a.at.localeCompare(b.at))
                .map((item) => (
                  <div key={item.id}>
                    <p className="mb-1 text-sm">{readable(itemDay(item, prefs.zone))}</p>
                    {card(item)}
                  </div>
                ))}
              {load === 'ready' && !shown.length ? <p>No content in this period.</p> : null}
              {canEdit ? <Button onClick={() => create(today)}>Plan a post</Button> : null}
            </div>
            <div
              className="hidden min-w-[700px] grid-cols-7 md:grid"
              aria-label={`${prefs.view} calendar`}
              style={
                prefs.view === 'week'
                  ? {
                      gridTemplateColumns: days
                        .map((day) => `minmax(${weekLayouts[day].lanes * 160 + 16}px, 1fr)`)
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
                  className={`relative min-w-0 border-b border-r p-2 ${prefs.view === 'week' ? '' : 'min-h-40'} ${day.slice(0, 7) !== anchor.slice(0, 7) && prefs.view === 'month' ? 'bg-muted/30' : ''} ${over === day ? 'bg-sky-500/10' : ''}`}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes(DRAG)) {
                      e.preventDefault()
                      setOver(day)
                    }
                  }}
                  onDragLeave={() => setOver(null)}
                  onDrop={(e) => drop(e, day)}
                >
                  {/* A fixed height: today's badge must not push its hour grid below the others. */}
                  <div className="sticky top-0 z-10 flex h-8 items-center justify-between bg-background text-xs">
                    <time
                      dateTime={day}
                      aria-current={day === today ? 'date' : undefined}
                      className={
                        day === today
                          ? 'rounded-full bg-sky-600 px-2 py-1 whitespace-nowrap text-white'
                          : 'whitespace-nowrap'
                      }
                    >
                      {readable(day, { weekday: 'short', day: 'numeric' })}
                    </time>
                    {canEdit && day >= today ? (
                      <Button
                        aria-label={`Create draft ${day}`}
                        onClick={() => create(day)}
                        size="icon-sm"
                        variant="ghost"
                      >
                        ＋
                      </Button>
                    ) : null}
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
                            {String(hour).padStart(2, '0')}:00
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
                      {shown
                        .filter((i) => itemDay(i, prefs.zone) === day)
                        .map((item) => card(item))}
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

function TimeFields({
  local,
  zone,
  choice,
  onLocal,
  onZone,
  onChoice,
}: {
  local: string
  zone: string
  choice: 'reject' | 'earlier' | 'later'
  onLocal: (v: string) => void
  onZone: (v: string) => void
  onChoice: (v: 'reject' | 'earlier' | 'later') => void
}) {
  return (
    <div className="grid gap-2">
      <Label className="grid gap-1.5">
        Date and time{' '}
        <span className="grid grid-cols-2 gap-2">
          <DatePicker
            className="w-full"
            aria-label="Day"
            min={wallTime(new Date(), isTimeZone(zone) ? zone : 'UTC').slice(0, 10)}
            value={local.slice(0, 10)}
            onChange={(day) => onLocal(`${day}T${local.slice(11)}`)}
          />
          <Input
            className="w-full"
            aria-label="Time"
            type="time"
            value={local.slice(11)}
            onChange={(e) => onLocal(`${local.slice(0, 10)}T${e.target.value}`)}
            step="60"
            list="quarter-hours"
          />
        </span>
        <datalist id="quarter-hours">
          {Array.from({ length: 96 }, (_, i) => (
            <NativeSelectOption
              key={i}
              value={`${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`}
            />
          ))}
        </datalist>
      </Label>
      <Label className="grid gap-1.5">
        Scheduling timezone{' '}
        <Input
          className="w-full"
          aria-label="Scheduling timezone"
          value={zone}
          onChange={(e) => onZone(e.target.value)}
        />
      </Label>
      <Label className="grid gap-1.5">
        Repeated hour{' '}
        <NativeSelect
          aria-label="Repeated hour"
          value={choice}
          onChange={(e) => onChoice(e.target.value as typeof choice)}
        >
          <NativeSelectOption value="reject">Ask me to choose</NativeSelectOption>
          <NativeSelectOption value="earlier">Earlier occurrence</NativeSelectOption>
          <NativeSelectOption value="later">Later occurrence</NativeSelectOption>
        </NativeSelect>
      </Label>
      <p className="text-xs text-muted-foreground">
        Today: {zonedDayKey(new Date(), isTimeZone(zone) ? zone : 'UTC')}. Any minute is supported.
      </p>
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
    zone?: string
    selected?: DraftWire
    source?: 'drafts' | 'posted'
  }
  sets: SocialSetWire[]
  canPublish: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const router = useRouter()
  const [setId, setSetId] = React.useState(context.setId)
  const set = sets.find((s) => s.id === setId)
  const [body, setBody] = React.useState<Value>([{ type: 'p', children: [{ text: '' }] }])
  const [kind, setKind] = React.useState<'standard' | 'article'>('standard')
  const [title, setTitle] = React.useState('')
  const [local, setLocal] = React.useState(`${context.day}T${context.time}`)
  const [zone, setZone] = React.useState(context.zone ?? set?.timeZone ?? 'UTC')
  const [choice, setChoice] = React.useState<'reject' | 'earlier' | 'later'>('reject')
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
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (!set || !set.accounts.some((a) => a.health === 'connected'))
        throw new Error(
          'Choose a connected account. Reconnect it in social-set settings if needed.'
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
        router.push(reviewScheduleHref(draft.id, instant, set.timeZone ?? zone))
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
      if (openEditor) router.push(`/write/${draft.id}`)
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
          <NativeSelect
            aria-label="Composer social account"
            className="w-full"
            value={setId}
            disabled={
              busy ||
              creationInput.current !== null ||
              reuseKey.current !== null ||
              created.current !== null
            }
            onChange={(e) => {
              setSetId(e.target.value)
              setZone(sets.find((s) => s.id === e.target.value)?.timeZone ?? 'UTC')
              setTagIds([])
              setSelected(null)
              setKind('standard')
            }}
          >
            {sets.map((s) => (
              <NativeSelectOption key={s.id} value={s.id}>
                {s.name} · {s.accounts.map((a) => a.platform).join(', ')}
              </NativeSelectOption>
            ))}
          </NativeSelect>
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
                      {set?.name} · {d.primaryPlatform} · Edited{' '}
                      {new Date(d.updatedAt).toLocaleString()}
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
              <NativeSelect
                aria-label="Post type"
                value={kind}
                disabled={busy || creationInput.current !== null}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                <NativeSelectOption value="standard">Post or thread</NativeSelectOption>
                {set?.accounts.some((a) => channelForPlatform(a.platform) === 'x') ? (
                  <NativeSelectOption value="article">X Article</NativeSelectOption>
                ) : null}
              </NativeSelect>
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
                <p className="text-xs">No tags in this publishing brand.</p>
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
          onZone={setZone}
          onChoice={setChoice}
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
          <Button disabled={busy || (picker && !selected)} onClick={() => void commit(false)}>
            {picker ? 'Plan' : 'Plan draft'}
          </Button>
          {picker ? (
            <Button
              disabled={busy || !selected || !canPublish}
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
  return `/write/${draftId}?${new URLSearchParams({ panel: 'schedule', day: wall.slice(0, 10), time: wall.slice(11) })}`
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
  const [activity, setActivity] = React.useState<DraftActivityWire[]>([])
  const [revisionCount, setRevisionCount] = React.useState<number | null>(null)
  const [local, setLocal] = React.useState(wallTime(new Date(item.at), item.zone))
  const router = useRouter()
  const [zone, setZone] = React.useState(item.zone)
  const [choice, setChoice] = React.useState<'reject' | 'earlier' | 'later'>('reject')
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
    Promise.allSettled([
      draftsApi.get(item.draftId),
      writeApi.activity(item.draftId),
      draftsApi.revisions(item.draftId),
    ]).then(([d, a, r]) => {
      if (!active) return
      if (d.status === 'fulfilled') setDraft(d.value)
      if (a.status === 'fulfilled') setActivity(a.value.items)
      if (r.status === 'fulfilled') setRevisionCount(r.value.items.length)
      const failure = [d, a, r].find((result) => result.status === 'rejected')
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
            {set?.name} · {item.platform} · {item.status}
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-4 p-4">
          <p className="whitespace-pre-wrap text-sm">{item.text}</p>
          <p className="text-xs">
            Original scheduling timezone: {item.zone}
            <br />
            {item.postId ? (
              <>
                {item.publishAt &&
                new Date(item.publishAt).getTime() !== new Date(item.at).getTime()
                  ? `Queue slot: ${new Date(item.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: item.zone })} · `
                  : ''}
                Scheduled for:{' '}
                {new Date(item.publishAt ?? item.at).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'medium',
                  timeZone: item.zone,
                })}{' '}
                ({item.zone}) · {new Date(item.publishAt ?? item.at).toISOString()}
              </>
            ) : (
              <>Planned for: {new Date(item.at).toISOString()} · planning never publishes</>
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
            <Link href={`/write/${item.draftId}`}>Open in editor</Link>
          </Button>
          <TimeFields
            local={local}
            zone={zone}
            choice={choice}
            onLocal={setLocal}
            onZone={setZone}
            onChoice={setChoice}
          />
          {item.deliveryStatus === 'SCHEDULED' && swapCandidates.length > 0 ? (
            <Label className="grid gap-1.5">
              Swap queue position
              <NativeSelect
                aria-label={`Swap queue position for ${item.text || item.title}`}
                disabled={busy || !canPublish}
                value=""
                onChange={(event) => {
                  const other = swapCandidates.find(
                    (candidate) => candidate.id === event.target.value
                  )
                  if (other)
                    void run(() =>
                      mutate('swap', [placement(item, other.at), placement(other, item.at)])
                    )
                }}
              >
                <NativeSelectOption value="">Choose a scheduled post…</NativeSelectOption>
                {swapCandidates.map((candidate) => (
                  <NativeSelectOption key={candidate.id} value={candidate.id}>
                    {candidate.text || candidate.title} · {new Date(candidate.at).toLocaleString()}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Label>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                busy ||
                (item.status === 'Planned' ? !canEdit : !canPublish) ||
                !['Planned', 'Scheduled', 'Overdue'].includes(item.status)
              }
              onClick={() =>
                void run(async () => {
                  const at = selectedInstant(local, zone, choice)
                  await mutate('move', [{ ...placement(item, at.toISOString()), timeZone: zone }])
                })
              }
            >
              {item.postId && queued.length > 1 ? `Move this ${item.platform} post` : 'Move'}
            </Button>
            {item.status === 'Planned' ? (
              <>
                <Button
                  disabled={busy || !canPublish}
                  onClick={() =>
                    void run(async () => {
                      const at = selectedInstant(local, zone, choice)
                      onClose()
                      router.push(reviewScheduleHref(item.draftId, at, set?.timeZone ?? zone))
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
              Move changes only this {item.platform} post. Unschedule returns the whole draft to a
              plan and cancels every queued destination:{' '}
              {queued.map((post) => post.platform).join(', ')}. To stop one destination only, cancel
              it from the draft’s posts in the editor.
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
            Copy to publishing brand{' '}
            <NativeSelect value={copySet} onChange={(e) => setCopySet(e.target.value)}>
              {sets.map((s) => (
                <NativeSelectOption key={s.id} value={s.id}>
                  {s.name} · {s.accounts.map((a) => a.platform).join(', ')}
                </NativeSelectOption>
              ))}
            </NativeSelect>
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
          {draft ? (
            <p className="text-xs">
              Content version {draft.version} · {draft.tagIds.length} tags · Review:{' '}
              {draft.reviewStatus}
            </p>
          ) : (
            <p role="status">Loading details…</p>
          )}
          <fieldset className="grid gap-2">
            <legend>Tags</legend>
            {detailTags === null ? (
              <p className="text-xs">Tags unavailable. Enable draft tags in Settings.</p>
            ) : detailTags.length === 0 ? (
              <p className="text-xs">No tags in this publishing brand.</p>
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
                    <span className="text-foreground">{post.platform}</span>
                    <Pill tone={POST_STATE_TONE[postState(post.status, post.scheduledFor)]}>
                      {postState(post.status, post.scheduledFor)}
                    </Pill>
                    <span className="text-muted-foreground">
                      {new Date(post.scheduledFor).toLocaleString(undefined, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                        timeZone: post.scheduleTimeZone ?? item.zone,
                      })}{' '}
                      · {post.scheduleTimeZone ?? item.zone}
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
                {activity.map((a) => (
                  <p key={a.id} className="my-2 text-xs">
                    {a.actorName ?? 'System'} ·{' '}
                    {a.action.replace(/^product\./, '').replaceAll('_', ' ')} ·{' '}
                    {new Date(a.at).toLocaleString()}
                  </p>
                ))}
                <Button asChild className="h-auto p-0" size={null} variant="link">
                  <Link href={`/write/${item.draftId}?panel=backups`}>
                    Browse revisions in editor
                  </Link>
                </Button>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
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
