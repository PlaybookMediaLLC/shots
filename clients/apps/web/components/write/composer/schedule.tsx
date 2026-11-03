'use client'

import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  socialSetKey,
  useSocialSetScope,
  type SocialSetRecord,
} from '@/components/settings/social-sets/api'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DatePicker } from '@/components/ui/date-picker'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { CHANNEL_META, ChannelIcon } from '@/components/drafts/channel-meta'
import { LocalTime } from '@/components/drafts/local-time'
import {
  call,
  DraftRequestError,
  type DraftPostWire,
  type DraftWire,
  draftsApi,
} from '@/lib/content-drafts/client'
import { type BlockImages, channelForPlatform } from '@/lib/content-drafts/serialize'
import { followUpLines } from '@/lib/write/automation'
import { writeApi } from '@/lib/write/client'
import type { AutoDm, Automation, Community } from '@/lib/write/document'
import { offsetLabel, readWhen, resolveLocalTime, wallTime } from '@/lib/write/zoned-time'
import { browserTimeZone } from '@/components/settings/TimeZonePicker'
import { cn } from '@/lib/utils'
import { AutomationControls } from './automation'
import { AutoDmDraft } from './auto-dm-draft'
import type { PreviewItem } from './preview'
import { healthLabel, SetDot } from '../sets'
import { useWrite } from '../write-context'
import type { SaveState } from './useDraftDocument'

/** A date's YYYY-MM-DD in a zone. */
function dayIn(at: Date, zone: string): string {
  return wallTime(at, zone).slice(0, 10)
}

/** What scheduling needs from the composer. */
export type ScheduleContext = {
  /** Every destination with its publication, to check before anything is queued. */
  items: PreviewItem[]
  approved: boolean
  canPublish: boolean
  /** An unsaved edit a newer version replaced, waiting for the writer's choice. */
  conflict: boolean
  draft: DraftWire
  flush: () => Promise<void>
  /** Try the failed save again. */
  retrySave: () => void
  /** Whether the latest edits are saved: review never sends content that is not. */
  saveState: SaveState
  onDone: (result: { draft: DraftWire; newDraft?: boolean }) => void
  onToggle: (accountId: string, on: boolean) => void
  requireApproval: boolean
  /** The draft's queued posts: a new schedule or Publish now replaces every one. */
  scheduled?: DraftPostWire[]
  setTimeZone: string | null
  versionRef: React.MutableRefObject<number>
  /** Render the draft's tables and math as uploaded images, in body order. */
  renderBlocks: () => Promise<BlockImages>
  /** The X version's follow-ups, and how to change them on the draft. */
  automation: Automation | undefined
  onAutomation?: (automation: Automation | undefined) => void
  community?: Community
  onCommunity?: (community: Community) => void
  autoDm?: AutoDm
  onAutoDm?: (config: AutoDm | undefined) => void
}

/** Problems that block every destination, collected for the dialogs. */
function blocking(context: ScheduleContext): string[] {
  const problems: string[] = []
  if (context.conflict)
    problems.push(
      'Your unsaved edit conflicts with a newer version. Choose what to do with it above the editor first.'
    )
  if (context.saveState === 'error' || context.saveState === 'offline')
    problems.push('Your latest edits are not saved. Retry saving before you schedule or publish.')
  if (context.draft.status === 'archived')
    problems.push('Restore this draft before scheduling or publishing.')
  if (context.items.length === 0)
    problems.push('Connect or turn on at least one account in this publishing brand.')
  for (const item of context.items) {
    if (item.account.health !== 'connected') {
      problems.push(`${CHANNEL_META[item.account.channel].label}: reconnect the account first.`)
    }
    for (const problem of item.publication.problems)
      problems.push(`${CHANNEL_META[item.account.channel].label}: ${problem}`)
  }
  if (context.requireApproval && !context.approved) {
    problems.push('This workspace approves drafts before they publish. Ask for review first.')
  }
  if (!context.canPublish)
    problems.push('Your role needs publishing permission to schedule or publish.')
  return problems
}

/**
 * Schedule or plan a draft (RFC 025). A planned time only puts the draft on
 * the calendar; Confirm makes it publish. Times are chosen in the set's zone
 * and resolved by the backend, which refuses a time the clocks skip and asks
 * which of two a repeated time means.
 */
export function ScheduleDialog({
  context,
  initialQueue,
  initialDay,
  initialTime,
  onClose,
  onPreview,
}: {
  context: ScheduleContext
  initialQueue?: boolean
  initialDay?: string
  initialTime?: string
  onClose: () => void
  onPreview?: () => void
}) {
  const { data } = useWrite()
  const scope = useSocialSetScope()
  // The draft's set owns the queue: its weekly slots in its zone (RFC 024).
  const setId =
    context.draft.socialSetId ?? data.sets.find((item) => item.visibility === 'WORKSPACE')?.id
  const cachedSet = useQueryClient().getQueryData<SocialSetRecord>(socialSetKey(scope, setId ?? ''))
  const set = cachedSet ?? data.sets.find((item) => item.id === setId)
  const zone = set?.timeZone ?? context.setTimeZone ?? 'UTC'
  const [localZone, setLocalZone] = React.useState<string | null>(null)
  React.useEffect(() => setLocalZone(browserTimeZone()), [])
  const now = new Date()
  const [day, setDay] = React.useState(() =>
    initialDay && /^\d{4}-\d{2}-\d{2}$/.test(initialDay)
      ? initialDay
      : dayIn(new Date(now.getTime() + 86_400_000), zone)
  )
  const [time, setTime] = React.useState(
    initialTime && /^([01]\d|2[0-3]):[0-5]\d$/.test(initialTime) ? initialTime : '09:00'
  )
  const [queue, setQueue] = React.useState(Boolean(initialQueue && data.advancedScheduling))
  const [continueWriting, setContinueWriting] = React.useState(context.draft.status === 'draft')
  // The draft's own choice, copied from its set when it was created (RFC 024).
  const [natural, setNatural] = React.useState(
    context.draft.naturalPostingTime && data.advancedScheduling
  )
  const [when, setWhen] = React.useState('')
  const [disambiguation, setDisambiguation] = React.useState<'earlier' | 'later' | null>(null)
  const [bestTimes, setBestTimes] = React.useState<{ at: string; reason: string }[]>([])
  // The queue slot the backend offers; scheduling reserves exactly this one.
  const [queueSlot, setQueueSlot] = React.useState<string | null>(null)
  const [slotNotice, setSlotNotice] = React.useState('')
  const [slotRequest, setSlotRequest] = React.useState(0)
  const [browsing, setBrowsing] = React.useState(false)
  // Which button is working, so only that one says so.
  const [action, setAction] = React.useState<'clear' | 'plan' | 'schedule' | null>(null)
  const [error, setError] = React.useState('')
  const busy = action !== null
  React.useEffect(() => {
    if (!data.advancedScheduling) return
    void draftsApi
      .bestTimes(setId)
      .then(({ items }) => setBestTimes(items))
      .catch(() => setBestTimes([]))
  }, [setId, data.advancedScheduling])
  React.useEffect(() => {
    if (!data.advancedScheduling || !setId) return
    let active = true
    void call<{ times: string[] }>('/api/v1/content-draft-batch/times', {
      body: { count: 1, mode: 'queue', seed: crypto.randomUUID(), socialSetId: setId },
      method: 'POST',
    })
      .then(({ times }) => {
        if (active) setQueueSlot(times[0] ?? null)
      })
      .catch((error) => {
        if (active) {
          setQueueSlot(null)
          setSlotNotice(error instanceof Error ? error.message : 'The queue could not be read.')
        }
      })
    return () => {
      active = false
    }
  }, [setId, data.advancedScheduling, slotRequest])
  const local = `${day}T${time}`
  const resolution = resolveLocalTime(local, zone)
  const instant =
    resolution.kind === 'exact'
      ? resolution.at
      : resolution.kind === 'ambiguous' && disambiguation
        ? resolution[disambiguation]
        : null
  const past = instant !== null && instant.getTime() <= Date.now()
  const problems = blocking(context)
  // The backend plans only drafts whose destinations are still active (not
  // removed or revoked); say so before a round trip.
  const planBlocked =
    context.items.length === 0
      ? 'To save as planned, choose a connected account for this draft first.'
      : context.items.some((item) => ['removed', 'revoked'].includes(item.account.health))
        ? 'To save as planned, reconnect the selected accounts first.'
        : null
  const today = dayIn(now, zone)
  const setInstant = (at: Date) => {
    const wall = wallTime(at, zone)
    setDay(wall.slice(0, 10))
    setTime(wall.slice(11))
    setQueue(false)
    setDisambiguation(null)
  }
  const slots = upcomingSlots(
    set?.postingSlots ?? [],
    zone,
    data.queue.map((item) => item.at)
  )
  const schedule = async () => {
    setAction('schedule')
    setError('')
    try {
      await context.flush()
      const result = await draftsApi.schedule(context.draft.id, {
        blockImages: await context.renderBlocks(),
        channelConnectionIds: context.items.map((item) => item.account.id),
        ...(queue
          ? { queue: true, expectedQueueSlot: queueSlot ?? undefined }
          : { disambiguation: disambiguation ?? undefined, localTime: local, timeZone: zone }),
        naturalPostingTime: natural,
        version: context.versionRef.current,
        baseCalendarVersion: context.draft.calendarVersion,
      })
      context.versionRef.current = result.draft.version
      context.onDone({ ...result, newDraft: continueWriting })
      const first = result.posts[0]
      toast.success(
        result.created
          ? `Scheduled ${result.posts.length} post${result.posts.length === 1 ? '' : 's'}${first ? ` for ${new Date(first.scheduledFor).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: zone })} (${zone})` : ''}.`
          : 'Already scheduled: nothing new was queued.'
      )
      onClose()
    } catch (error) {
      const next = error instanceof DraftRequestError ? error.details.nextQueueSlot : undefined
      if (queue && typeof next === 'string') {
        // Another schedule took the reviewed slot: show the next one; never move silently.
        setQueueSlot(next)
        setSlotNotice(
          'That slot was just taken. Review the next free slot below and confirm again.'
        )
      } else {
        setError(error instanceof Error ? error.message : 'The draft could not be scheduled.')
      }
    } finally {
      setAction(null)
    }
  }
  const plan = async (clear = false) => {
    setAction(clear ? 'clear' : 'plan')
    setError('')
    try {
      await context.flush()
      const saved = await writeApi.plan(context.draft.id, {
        baseCalendarVersion: context.draft.calendarVersion,
        plannedFor: clear || !instant ? null : instant.toISOString(),
        timeZone: zone,
      })
      context.onDone({ draft: saved })
      toast.success(
        clear ? 'Plan cleared.' : 'Planned. It is on the calendar and will not publish by itself.'
      )
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The draft could not be planned.')
    } finally {
      setAction(null)
    }
  }
  const reviewedSlot = queueSlot ? new Date(queueSlot) : null
  const summary = queue
    ? reviewedSlot
      ? `Next free slot: ${reviewedSlot.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short', timeZone: zone })} · ${zone} (${offsetLabel(reviewedSlot, zone)})`
      : 'Finding the next free queue slot…'
    : instant
      ? `${instant.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short', timeZone: zone })} · ${zone} (${offsetLabel(instant, zone)})`
      : resolution.kind === 'gap'
        ? 'That time does not exist here: the clocks skip it.'
        : 'Choose which of the two times you mean.'
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent
        className="max-h-[92dvh] max-w-xl gap-4 overflow-y-auto"
        data-testid="schedule-dialog"
      >
        <DialogHeader>
          <DialogTitle>Schedule</DialogTitle>
          <DialogDescription>
            Times are in {zone} ({offsetLabel(instant ?? now, zone)}). Save as planned keeps it on
            the calendar without publishing.
          </DialogDescription>
        </DialogHeader>
        <Button
          className="justify-start px-0 text-xs underline"
          size="sm"
          variant="ghost"
          onClick={() => {
            onClose()
            const url = new URL(window.location.href)
            url.searchParams.set('settings', 'scheduling')
            window.history.pushState(null, '', url)
          }}
        >
          Time zone: {zone} · Change brand settings
        </Button>
        {queue ? null : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Label className="grid content-start gap-1 text-xs text-muted-foreground">
              Day
              <DatePicker
                aria-label="Day"
                min={today}
                onChange={(value) => {
                  if (value >= today) {
                    setDay(value)
                    setDisambiguation(null)
                  }
                }}
                value={day}
              />
            </Label>
            <div className="grid content-start gap-2">
              <Label className="grid gap-1 text-xs text-muted-foreground">
                Time
                <Input
                  aria-label="Time"
                  onChange={(event) => {
                    setTime(event.target.value)
                    setDisambiguation(null)
                  }}
                  type="time"
                  value={time}
                />
              </Label>
              {resolution.kind === 'ambiguous' ? (
                <fieldset className="grid gap-1 text-xs" data-testid="ambiguous-time">
                  <legend className="text-amber-700 dark:text-amber-300">
                    {time} happens twice that day. Which one?
                  </legend>
                  <RadioGroup
                    className="gap-1"
                    onValueChange={(value) =>
                      setDisambiguation(value === 'later' ? 'later' : 'earlier')
                    }
                    value={disambiguation ?? ''}
                  >
                    {(['earlier', 'later'] as const).map((option) => (
                      <Label className="flex items-center gap-2" key={option}>
                        <RadioGroupItem value={option} />
                        {option === 'earlier' ? 'The first' : 'The second'} (
                        {resolution[option].toLocaleTimeString(undefined, {
                          hour: 'numeric',
                          minute: '2-digit',
                          timeZoneName: 'short',
                        })}
                        )
                      </Label>
                    ))}
                  </RadioGroup>
                </fieldset>
              ) : null}
              {resolution.kind === 'gap' ? (
                <p className="text-xs text-red-700 dark:text-red-300" role="alert">
                  {time} does not exist on that day in {zone}: the clocks skip it. Pick another
                  time.
                </p>
              ) : null}
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {[
            { at: nextQuarter(new Date(Date.now() + 15 * 60_000)), label: 'Today' },
            { at: atNine(1, zone), label: 'Tomorrow 9:00' },
            { at: atNine(nextMondayOffset(zone), zone), label: 'Later: Monday 9:00' },
          ].map((option) => (
            <Button
              className="rounded-full"
              key={option.label}
              onClick={() => setInstant(option.at)}
              size="sm"
              type="button"
              variant="outline"
            >
              {option.label}
            </Button>
          ))}
          <Button
            disabled={!data.advancedScheduling}
            aria-pressed={queue}
            className={cn('rounded-full', queue && 'border-sky-400/60 text-sky-700 dark:text-sky-200')}
            onClick={() => setQueue(!queue)}
            size="sm"
            type="button"
            variant="outline"
          >
            Next free slot
            {reviewedSlot
              ? ` · ${reviewedSlot.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone, timeZoneName: 'short' })}`
              : ' · none available'}
          </Button>
        </div>
        {slotNotice ? (
          <p
            className="flex flex-wrap items-center gap-2 text-xs text-amber-700 dark:text-amber-300"
            data-testid="queue-slot-notice"
            role="alert"
          >
            {slotNotice}
            {!reviewedSlot ? (
              <Button
                onClick={() => {
                  setSlotNotice('')
                  setSlotRequest((value) => value + 1)
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                Check again
              </Button>
            ) : null}
          </p>
        ) : null}
        {data.advancedScheduling ? (
          <details
            className="rounded-lg border border-border p-3"
            open={initialQueue || undefined}
          >
            <summary className="cursor-pointer text-sm text-foreground">
              Advanced scheduling
            </summary>
            <div className="mt-3 grid gap-3">
              <Input
                aria-label="When, in words"
                onChange={(event) => {
                  setWhen(event.target.value)
                  const wall = readWhen(event.target.value, zone)
                  if (wall) {
                    setDay(wall.slice(0, 10))
                    setTime(wall.slice(11))
                    setQueue(false)
                    setDisambiguation(null)
                  }
                }}
                placeholder='Type a time: "tomorrow 9am", "in 3 hours", "fri 2pm"'
                value={when}
              />
              {when ? (
                <p className="text-xs text-muted-foreground" data-testid="when-reading">
                  {readWhen(when, zone)
                    ? `→ ${summary}`
                    : `Could not read that time. Still selected: ${summary}.`}
                </p>
              ) : null}
              {bestTimes.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">Suggested times</span>
                  {bestTimes.map((best) => (
                    <Button
                      className="rounded-full border-emerald-400/30 text-emerald-700 dark:text-emerald-200"
                      key={best.at}
                      onClick={() => setInstant(new Date(best.at))}
                      size="sm"
                      title={best.reason}
                      type="button"
                      variant="outline"
                    >
                      {new Date(best.at).toLocaleString(undefined, {
                        hour: 'numeric',
                        minute: '2-digit',
                        timeZone: zone,
                        weekday: 'short',
                      })}
                      <span className="ml-1 text-xs text-foreground">· {best.reason}</span>
                    </Button>
                  ))}
                </div>
              ) : null}
              <Button
                className="rounded-full"
                onClick={() => setBrowsing(!browsing)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {browsing ? 'Hide queue' : 'Browse queue'}
              </Button>
              {browsing ? (
                <ul
                  className="grid max-h-40 gap-1 overflow-y-auto rounded-md border border-border p-2 text-xs"
                  data-testid="queue-slots"
                >
                  {slots.length === 0 ? (
                    <li className="text-muted-foreground">
                      No weekly slots: add them in the set’s scheduling settings.
                    </li>
                  ) : null}
                  {slots.map((slot) => (
                    <li className="flex items-center justify-between" key={slot.at.toISOString()}>
                      <LocalTime
                        options={{
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                          month: 'short',
                          timeZone: zone,
                          weekday: 'short',
                        }}
                        value={slot.at.toISOString()}
                      />
                      {slot.busy ? (
                        <span className="text-muted-foreground">taken</span>
                      ) : (
                        <Button
                          onClick={() => setInstant(slot.at)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Schedule here
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
              <Label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  Natural posting time
                  <span className="block text-[11px] text-muted-foreground">
                    Shifts this post by up to four minutes either way so it does not land on the
                    minute; a retry keeps the same time.
                  </span>
                </span>
                <Switch
                  aria-label="Natural posting time"
                  checked={natural}
                  onCheckedChange={(checked) => setNatural(checked === true)}
                />
              </Label>
            </div>
          </details>
        ) : (
          <p className="text-sm text-muted-foreground">
            <a href="/pricing" className="underline">
              Upgrade to Pro
            </a>{' '}
            for queue slots, suggested times and automatic follow-ups.
          </p>
        )}
        <Destinations context={context} publishAt={instant ?? now} timeZone={zone} />
        <p
          className="rounded-md bg-foreground/[0.03] px-3 py-2 text-sm text-foreground"
          data-testid="schedule-summary"
        >
          {summary}
          {!queue && instant && localZone && localZone !== zone ? (
            <span className="block text-xs text-foreground">
              {instant.toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
                timeZone: localZone,
              })}{' '}
              · {localZone.replaceAll('_', ' ')}
            </span>
          ) : null}
          {natural && (queue ? reviewedSlot : instant) ? (
            <span className="text-muted-foreground"> ± up to 4 minutes</span>
          ) : null}
        </p>
        <ReplacedPosts context={context} timeZone={zone} />
        {past && !queue ? <p className="text-xs text-red-700 dark:text-red-300">That time has passed.</p> : null}
        <Problems context={context} problems={problems} />
        <ActionError message={error} />
        <Label className="flex items-center gap-2 text-xs">
          <Checkbox
            checked={continueWriting}
            onCheckedChange={(checked) => setContinueWriting(checked === true)}
          />
          Open a new draft after scheduling
        </Label>
        <DialogFooter className="flex-wrap gap-2">
          {onPreview ? <Button onClick={onPreview} type="button" variant="outline">Preview</Button> : null}
          {context.draft.plannedFor ? (
            <Button
              className="mr-auto"
              disabled={busy}
              onClick={() => void plan(true)}
              type="button"
              variant="ghost"
            >
              Clear planned time
            </Button>
          ) : null}
          {planBlocked ? (
            <p className="basis-full text-xs text-muted-foreground" role="status">
              {planBlocked}
            </p>
          ) : null}
          <Button
            disabled={
              busy ||
              context.draft.status === 'archived' ||
              queue ||
              !instant ||
              past ||
              Boolean(planBlocked)
            }
            onClick={() => void plan()}
            type="button"
            variant="outline"
          >
            {action === 'plan' ? 'Saving…' : 'Save as planned'}
          </Button>
          <Button
            disabled={busy || problems.length > 0 || (queue ? !reviewedSlot : !instant || past)}
            onClick={() => void schedule()}
            type="button"
          >
            {action === 'schedule'
              ? 'Scheduling…'
              : queue
                ? 'Confirm: next free slot'
                : 'Confirm schedule'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The next quarter hour at or after an instant. */
function nextQuarter(at: Date): Date {
  const next = new Date(at)
  next.setSeconds(0, 0)
  next.setMinutes(Math.ceil(next.getMinutes() / 15) * 15)
  return next
}

/** 9:00 in a zone, some days from today. */
function atNine(days: number, zone: string): Date {
  const day = dayIn(new Date(Date.now() + days * 86_400_000), zone)
  const resolved = resolveLocalTime(`${day}T09:00`, zone)
  return resolved.kind === 'exact'
    ? resolved.at
    : resolved.kind === 'ambiguous'
      ? resolved.earlier
      : new Date(Date.now() + days * 86_400_000)
}

/** Days until next Monday in a zone (7 on a Monday). */
function nextMondayOffset(zone: string): number {
  const weekday = new Date(`${dayIn(new Date(), zone)}T12:00:00Z`).getUTCDay()
  return (8 - weekday) % 7 || 7
}

/** The next weekly slots in the zone, marking those a queued post already takes. */
function upcomingSlots(
  postingSlots: { time: string; weekday: number }[],
  zone: string,
  taken: string[]
): { at: Date; busy: boolean }[] {
  const out: { at: Date; busy: boolean }[] = []
  for (let days = 0; days < 21 && out.length < 12; days += 1) {
    const day = dayIn(new Date(Date.now() + days * 86_400_000), zone)
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay()
    for (const slot of postingSlots.filter((item) => item.weekday === weekday)) {
      const resolved = resolveLocalTime(`${day}T${slot.time}`, zone)
      if (resolved.kind !== 'exact' || resolved.at.getTime() <= Date.now()) continue
      out.push({
        at: resolved.at,
        busy: taken.some(
          (item) => Math.abs(new Date(item).getTime() - resolved.at.getTime()) < 5 * 60_000
        ),
      })
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, 12)
}

/** One persisted audience choice shared by scheduling and immediate-publish review. */
function CommunityTimeline({ context }: { context: ScheduleContext }) {
  if (!context.community || !context.items.some((item) => item.account.channel === 'x')) return null
  return (
    <Label className="flex items-center justify-between gap-3 py-2 text-sm">
      <span>
        Share to timeline
        <span className="block text-xs text-muted-foreground">
          Also share this community post with your followers. It remains public when off.
        </span>
      </span>
      <Switch
        aria-label="Share to timeline"
        checked={context.community.shareWithFollowers ?? true}
        disabled={!context.onCommunity}
        onCheckedChange={(shareWithFollowers) =>
          context.onCommunity?.({ ...context.community!, shareWithFollowers })
        }
      />
    </Label>
  )
}

/** The destinations with their switches, accounts and health. */
function Destinations({
  context,
  publishAt,
  timeZone,
}: {
  context: ScheduleContext
  publishAt: Date
  timeZone: string
}) {
  const { data } = useWrite()
  const setId =
    context.draft.socialSetId ?? data.sets.find((set) => set.visibility === 'WORKSPACE')?.id
  const set = data.sets.find((item) => item.id === setId)
  if (!set) return null
  const on = new Set(context.items.map((item) => item.account.id))
  return (
    <fieldset className="grid gap-1" data-testid="destinations">
      <legend className="mb-1 flex items-center gap-1.5 text-sm">
        <SetDot color={set.color} /> {set.name}
      </legend>
      {set.accounts.map((account) => (
        <Label className="flex items-center gap-3 rounded-md px-1 py-1 text-sm" key={account.id}>
          <ChannelIcon channel={account.channel} className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            {account.displayName ?? account.handle ?? CHANNEL_META[account.channel].label}
            {account.handle ? (
              <span className="ml-1.5 text-muted-foreground">@{account.handle}</span>
            ) : null}
            {account.health !== 'connected' ? (
              <span className="ml-1.5 text-amber-700 dark:text-amber-300">
                {healthLabel(account.health).toLowerCase()}
              </span>
            ) : null}
          </span>
          <Switch
            aria-label={`Publish to ${CHANNEL_META[account.channel].label}`}
            checked={on.has(account.id)}
            onCheckedChange={(checked) => context.onToggle(account.id, checked === true)}
          />
        </Label>
      ))}
      <CommunityTimeline context={context} />
      {context.items.some((item) => item.account.channel === 'x') ? (
        <AutoDmDraft
          value={context.autoDm}
          onChange={(next) => context.onAutoDm?.(next)}
          readOnly={!context.onAutoDm}
        />
      ) : null}
      {data.advancedScheduling && context.items.some((item) => item.account.channel === 'x') ? (
        <AutomationControls
          automation={context.automation}
          onChange={(next) => context.onAutomation?.(next)}
          publishAt={publishAt}
          readOnly={!context.onAutomation}
          setId={set.id}
          timeZone={timeZone}
        />
      ) : null}
    </fieldset>
  )
}

/**
 * The draft's queued posts that confirming replaces, one line per
 * destination: a schedule replaces them all, so a destination switched off
 * here is cancelled rather than left at its old time.
 */
function ReplacedPosts({ context, timeZone }: { context: ScheduleContext; timeZone: string }) {
  const { data } = useWrite()
  const scheduled = context.scheduled ?? []
  if (scheduled.length === 0) return null
  const selected = new Set(context.items.map((item) => item.account.id))
  const accounts = new Map(
    data.sets.flatMap((set) => set.accounts.map((account) => [account.id, account] as const))
  )
  return (
    <div
      className="grid gap-1 rounded-md border border-amber-400/40 p-2 text-xs"
      data-testid="replaced-posts"
    >
      <p className="text-foreground">
        Confirming replaces{' '}
        {scheduled.length === 1 ? 'the queued post' : `all ${scheduled.length} queued posts`} of
        this draft:
      </p>
      <ul className="grid gap-0.5">
        {scheduled.map((post) => {
          const channel = channelForPlatform(post.platform)
          const account = accounts.get(post.channelConnectionId)
          return (
            <li className="flex flex-wrap items-center gap-1.5" key={post.id}>
              {channel ? <ChannelIcon channel={channel} className="size-3.5" /> : null}
              {account?.displayName ??
                account?.handle ??
                (channel ? CHANNEL_META[channel].label : post.platform)}
              <span className="text-muted-foreground">
                ·{' '}
                {new Date(post.scheduledFor).toLocaleString(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                  timeZone,
                })}
              </span>
              {selected.has(post.channelConnectionId) ? (
                <span className="text-muted-foreground">→ moves to the new time</span>
              ) : (
                <span className="text-amber-700 dark:text-amber-300">
                  → cancelled: not selected
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** A list of blocking problems, or nothing; a failed save can be retried from here. */
function Problems({ context, problems }: { context: ScheduleContext; problems: string[] }) {
  if (problems.length === 0) return null
  return (
    <div className="grid gap-1.5" data-testid="blocking-problems" role="alert">
      <ul className="grid gap-0.5">
        {problems.map((problem) => (
          <li className="text-xs text-red-700 dark:text-red-300" key={problem}>
            {problem}
          </li>
        ))}
      </ul>
      {context.saveState === 'error' || context.saveState === 'offline' ? (
        <Button
          className="w-fit"
          onClick={context.retrySave}
          size="sm"
          type="button"
          variant="outline"
        >
          Retry save
        </Button>
      ) : null}
    </div>
  )
}

/** Why the last action failed, kept in the dialog with the draft untouched. */
function ActionError({ message }: { message: string }) {
  if (!message) return null
  return (
    <p
      className="rounded-md border border-red-500/30 px-3 py-2 text-sm text-red-700 dark:text-red-300"
      data-testid="action-error"
      role="alert"
    >
      {message} Your draft and its text are kept.
    </p>
  )
}

/**
 * The final review before publishing now (RFC 025): the set, each exact
 * account, what each will post, how many posts, media, audience and labels,
 * follow-ups, who may publish and the approval state. Only Publish now
 * publishes, once: the same version and accounts replay rather than repeat.
 */
export function PublishReview({
  context,
  onClose,
  onPreview,
}: {
  context: ScheduleContext
  onClose: () => void
  onPreview: () => void
}) {
  const { data } = useWrite()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const problems = blocking(context)
  const set = data.sets.find(
    (item) =>
      item.id ===
      (context.draft.socialSetId ?? data.sets.find((entry) => entry.visibility === 'WORKSPACE')?.id)
  )
  const followUps = context.items.flatMap(({ account, publication }) =>
    followUpLines(
      publication.target.autoActions,
      publication.target.options?.firstComment,
      CHANNEL_META[account.channel].label
    )
  )
  const publish = async () => {
    setBusy(true)
    setError('')
    try {
      await context.flush()
      const result = await draftsApi.schedule(context.draft.id, {
        blockImages: await context.renderBlocks(),
        channelConnectionIds: context.items.map((item) => item.account.id),
        publishNow: true,
        version: context.versionRef.current,
      })
      context.versionRef.current = result.draft.version
      context.onDone(result)
      toast.success(
        result.created
          ? 'Publishing now. Each destination reports its own result below.'
          : 'Already published at this version: nothing new was sent.'
      )
      onClose()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The draft could not be published.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent
        className="max-h-[92dvh] max-w-xl gap-4 overflow-y-auto"
        data-testid="publish-review"
      >
        <DialogHeader>
          <DialogTitle>Publish now</DialogTitle>
          <DialogDescription>
            Check exactly what goes where. Nothing is sent until you confirm.
          </DialogDescription>
        </DialogHeader>
        {set ? (
          <p className="flex items-center gap-1.5 text-sm">
            <SetDot color={set.color} /> Publishing as{' '}
            <span className="font-medium text-foreground">{set.name}</span>
          </p>
        ) : null}
        <ul className="grid gap-2">
          {context.items.map(({ account, publication }) => {
            const posts = publication.serialized.posts
            const media = posts.reduce((total, post) => total + post.images, 0)
            const first = publication.target.options
            return (
              <li
                className="rounded-lg border border-border p-3 text-sm"
                data-testid="review-destination"
                key={account.id}
              >
                <p className="flex items-center gap-1.5 text-foreground">
                  <ChannelIcon channel={account.channel} />
                  {account.displayName ?? CHANNEL_META[account.channel].label}
                  {account.handle ? (
                    <span className="text-muted-foreground">@{account.handle}</span>
                  ) : null}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {posts.length > 1 ? `A thread of ${posts.length} posts` : 'One post'}
                  {media > 0 ? ` · ${media} media` : ''}
                  {publication.target.poll ? ' · a poll' : ''}
                  {first?.documentAssetId ? ' · a PDF document' : ''}
                  {first?.communityId ? ` · to community ${first.communityId}` : ''}
                  {first?.visibility === 'CONNECTIONS' ? ' · connections only' : ''}
                  {first?.replySettings ? ` · replies: ${first.replySettings}` : ''}
                  {first?.madeWithAi ? ' · labelled made with AI' : ''}
                  {first?.paidPartnership ? ' · labelled paid partnership' : ''}
                  {publication.target.replyTo ? ' · a reply' : ''}
                  {first?.quoteRemoteId ? ' · a quote' : ''}
                </p>
                <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-sm text-foreground">
                  {posts[0]?.caption}
                </p>
                {publication.problems.map((problem) => (
                  <p className="mt-1 text-xs text-red-700 dark:text-red-300" key={problem}>
                    {problem}
                  </p>
                ))}
              </li>
            )
          })}
        </ul>
        <ReplacedPosts context={context} timeZone={context.setTimeZone ?? 'UTC'} />
        <CommunityTimeline context={context} />
        {context.items.some((item) => item.account.channel === 'x') ? (
          <AutoDmDraft
            value={context.autoDm}
            onChange={(next) => context.onAutoDm?.(next)}
            readOnly={!context.onAutoDm}
          />
        ) : null}
        {data.advancedScheduling && context.items.some((item) => item.account.channel === 'x') ? (
          <AutomationControls
            automation={context.automation}
            onChange={(next) => context.onAutomation?.(next)}
            publishAt={new Date()}
            readOnly={!context.onAutomation}
            setId={set?.id ?? null}
            timeZone={context.setTimeZone ?? 'UTC'}
          />
        ) : null}
        {followUps.length > 0 ? (
          <div className="text-xs text-muted-foreground">
            <p className="text-foreground">After it is live</p>
            <ul className="list-inside list-disc">
              {followUps.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {context.requireApproval
            ? context.approved
              ? 'Approved at this version.'
              : 'Not approved at this version.'
            : 'This workspace does not require approval.'}{' '}
          {context.canPublish ? 'You can publish.' : 'You cannot publish.'}
        </p>
        <Problems context={context} problems={problems} />
        <ActionError message={error} />
        <DialogFooter>
          <Button onClick={onPreview} type="button" variant="ghost">
            Preview
          </Button>
          <Button onClick={onClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            disabled={busy || problems.length > 0}
            onClick={() => void publish()}
            type="button"
          >
            {busy ? 'Publishing…' : 'Publish now'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
