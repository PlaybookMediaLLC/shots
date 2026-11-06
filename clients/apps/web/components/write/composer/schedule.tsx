'use client'

import { openBrandSettings } from '@/components/drafts/DraftSettingsDrawer'
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
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { TimePicker } from '@/components/ui/time-picker'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { CHANNEL_META, ChannelIcon } from '@/components/drafts/channel-meta'
import { LocalTime, useWhen } from '@/components/drafts/local-time'
import {
  call,
  DraftRequestError,
  type DraftPostWire,
  type DraftWire,
  draftsApi,
} from '@/lib/content-drafts/client'
import { type BlockImages, channelForPlatform } from '@/lib/content-drafts/serialize'
import { followUpLines } from '@/lib/write/automation'
import { upcomingSlots } from '@/lib/write/calendar'
import { writeApi } from '@/lib/write/client'
import type { AutoDm, Automation, Community, DraftChannel } from '@/lib/write/document'
import type { DraftKind } from '@/lib/write/document'
import { platformRefusal } from '@/lib/write/platform-rules'
import {
  committedMessage,
  offsetLabel,
  readWhen,
  resolveLocalTime,
  wallTime,
} from '@/lib/write/zoned-time'
import { browserTimeZone } from '@/lib/time-zones'
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
  kind: DraftKind
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
  /** Undo a schedule just confirmed: cancel its posts and put back the draft's plan as it was. */
  undoSchedule?: (before: DraftWire, postId: string) => Promise<void>
}

/**
 * One thing that blocks scheduling, the platform it belongs to, if any, and
 * where it is fixed: the platform's post options, its account, the save, the
 * edit conflict, the review, or restoring the draft. Without one, the text.
 */
export type ScheduleBlocker = {
  channel?: DraftChannel
  fix?: 'account' | 'conflict' | 'restore' | 'review' | 'save'
  options?: boolean
  text: string
}

/**
 * What blocks scheduling every destination, checked live as the draft
 * changes: the header shows these beside Schedule, and the dialogs list them.
 */
export function scheduleBlockers(
  context: Pick<
    ScheduleContext,
    'approved' | 'canPublish' | 'conflict' | 'draft' | 'items' | 'requireApproval' | 'saveState'
  >
): ScheduleBlocker[] {
  const problems: ScheduleBlocker[] = []
  if (context.conflict)
    problems.push({
      fix: 'conflict',
      text: 'Your unsaved edit conflicts with a newer version. Choose what to do with it above the editor first.',
    })
  if (context.saveState === 'error' || context.saveState === 'offline')
    problems.push({
      fix: 'save',
      text: 'Your latest edits are not saved. Retry saving before you schedule or publish.',
    })
  if (context.draft.status === 'archived')
    problems.push({ fix: 'restore', text: 'Restore this draft before scheduling or publishing.' })
  if (context.items.length === 0)
    problems.push({
      fix: 'account',
      text: 'Connect or turn on at least one account in this profile.',
    })
  for (const item of context.items) {
    const channel = item.account.channel
    if (item.account.health !== 'connected') {
      problems.push({
        channel,
        fix: 'account',
        text: `${CHANNEL_META[channel].label}: reconnect the account first.`,
      })
    }
    for (const problem of item.publication.problems)
      problems.push({
        channel,
        fix: item.publication.accountProblems.includes(problem) ? 'account' : undefined,
        options: item.publication.optionProblems.includes(problem),
        // Some problems already start with the platform's name.
        text: problem.startsWith(CHANNEL_META[channel].label)
          ? problem
          : `${CHANNEL_META[channel].label}: ${problem}`,
      })
  }
  if (context.requireApproval && !context.approved) {
    problems.push({
      fix: 'review',
      text: 'This workspace approves drafts before they publish. Ask for review first.',
    })
  }
  if (!context.canPublish)
    problems.push({ text: 'Your role needs publishing permission to schedule or publish.' })
  return problems
}

/** Where a blocker takes you, as its button says it. */
export function blockerFixLabel(blocker: ScheduleBlocker): string {
  const platform = blocker.channel ? CHANNEL_META[blocker.channel].label : ''
  if (blocker.fix === 'account') return 'Open platforms'
  if (blocker.fix === 'conflict') return 'Go to the conflict'
  if (blocker.fix === 'restore') return 'Restore the draft'
  if (blocker.fix === 'review') return 'Open review'
  if (blocker.fix === 'save') return 'Retry saving'
  if (blocker.options) return `Open ${platform} settings`
  return blocker.channel ? `Go to the ${platform} post` : ''
}

/** Problems that block every destination, collected for the dialogs. */
function blocking(context: ScheduleContext): string[] {
  return scheduleBlockers(context).map((problem) => problem.text)
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
  const formatWhen = useWhen()
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
  const [slotLoading, setSlotLoading] = React.useState(false)
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
    setSlotLoading(true)
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
      .finally(() => {
        if (active) setSlotLoading(false)
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
  const freeSlots = slots.filter((slot) => !slot.busy).slice(0, 3)
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
      // Undo cancels what this schedule queued. A reschedule replaced earlier posts,
      // which Undo cannot bring back, so it offers none.
      const undo = rescheduling ? undefined : context.undoSchedule
      const [first] = result.posts
      const before = context.draft
      toast.success(
        result.created
          ? committedMessage(result.posts, zone, queue)
          : 'Already scheduled: nothing new was queued.',
        result.created && undo && first
          ? { action: { label: 'Undo', onClick: () => void undo(before, first.id) } }
          : undefined
      )
      onClose()
    } catch (error) {
      const next = error instanceof DraftRequestError ? error.details.nextQueueSlot : undefined
      if (queue && typeof next === 'string') {
        // Another schedule took the reviewed slot: show the next one; never move silently.
        setQueueSlot(next)
        setSlotNotice(
          'That slot was just taken. Review the next free slot above and confirm again.'
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
  const confirmable = !(
    busy ||
    problems.length > 0 ||
    (queue ? !reviewedSlot : !instant || past)
  )
  // A draft with queued posts is rescheduled: confirming replaces them (listed below).
  const rescheduling = (context.scheduled ?? []).length > 0
  const chosen = queue ? reviewedSlot : instant
  const headline = chosen
    ? formatWhen(chosen, zone, { dateStyle: 'full', timeStyle: 'short' })
    : queue
      ? slotLoading
        ? 'Finding the next free slot…'
        : 'No free slot available'
      : resolution.kind === 'gap'
        ? 'That time does not exist here: the clocks skip it.'
        : 'Choose which of the two times you mean.'
  const summary = chosen
    ? `${queue ? 'Next free slot: ' : ''}${headline} · ${zone} (${offsetLabel(chosen, zone)})`
    : headline
  const quickPicks = [
    { at: nextQuarter(new Date(Date.now() + 15 * 60_000)), label: 'Today' },
    { at: atNine(1, zone), label: 'Tomorrow 9:00' },
    { at: atNine(nextMondayOffset(zone), zone), label: 'Monday 9:00' },
  ]
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent
        className="max-h-[92dvh] max-w-[calc(100%-1rem)] gap-6 overflow-y-auto p-5 sm:max-w-lg sm:p-6"
        data-testid="schedule-dialog"
        onKeyDown={(event) => {
          // ⌘↵ alone confirms, so the next free slot is a keyboard-only path. ⌘⇧↵ and
          // ⌘⌥↵ are the composer's publish-review and queue shortcuts: never a schedule.
          // React passes keys from a dialog opened over this one (Auto-DM settings)
          // up to here: only a key pressed in this dialog confirms it.
          if (
            event.currentTarget.contains(event.target as Node) &&
            event.key === 'Enter' &&
            (event.metaKey || event.ctrlKey) &&
            !event.shiftKey &&
            !event.altKey &&
            confirmable
          ) {
            event.preventDefault()
            void schedule()
          }
        }}
      >
        <DialogHeader className="gap-1.5 text-left">
          <DialogTitle>{rescheduling ? 'Reschedule' : 'Schedule'}</DialogTitle>
          <DialogDescription className="text-xs">
            Times are in {zone} ({offsetLabel(chosen ?? now, zone)}).{' '}
            <Button
              className="h-auto p-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              size={null}
              variant="custom"
              onClick={() => {
                onClose()
                openBrandSettings('scheduling', setId)
              }}
            >
              Change
            </Button>
          </DialogDescription>
        </DialogHeader>
        <section aria-label="When" className="grid gap-4">
          {data.advancedScheduling ? (
            <SegmentedControl
              ariaLabel="How to schedule"
              className="h-9 max-lg:h-9 [&_button]:text-xs"
              onChange={(value) => setQueue(value === 'queue')}
              options={[
                { id: 'time', label: 'At a time' },
                { id: 'queue', label: 'Next free slot' },
              ]}
              value={queue ? 'queue' : 'time'}
            />
          ) : null}
          {queue ? null : (
            <div className="grid gap-4">
              <TimeChips
                chosen={instant}
                heading="Next free slots"
                onPick={setInstant}
                testId="free-slot-picks"
                times={freeSlots.map((slot) => ({ at: slot.at }))}
                zone={zone}
              />
              <div className="grid grid-cols-2 gap-3">
                <Label className="grid content-start gap-1.5 text-xs text-muted-foreground">
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
                <Label className="grid content-start gap-1.5 text-xs text-muted-foreground">
                  Time
                  <TimePicker
                    aria-label="Time"
                    className="w-full"
                    onChange={(next) => {
                      setTime(next)
                      setDisambiguation(null)
                    }}
                    value={time}
                  />
                </Label>
              </div>
              {resolution.kind === 'ambiguous' ? (
                <fieldset className="grid gap-2 text-xs" data-testid="ambiguous-time">
                  <legend className="mb-2 text-amber-700 dark:text-amber-300">
                    {time} happens twice that day. Which one?
                  </legend>
                  <RadioGroup
                    className="flex flex-wrap gap-4"
                    onValueChange={(value) =>
                      setDisambiguation(value === 'later' ? 'later' : 'earlier')
                    }
                    value={disambiguation ?? ''}
                  >
                    {(['earlier', 'later'] as const).map((option) => (
                      <Label className="flex items-center gap-2" key={option}>
                        <RadioGroupItem value={option} />
                        {option === 'earlier' ? 'The first' : 'The second'} (
                        {formatWhen(resolution[option], zone, {
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
              <div className="flex flex-wrap gap-2">
                {quickPicks.map((option) => (
                  <Button
                    aria-pressed={instant?.getTime() === option.at.getTime()}
                    className="h-8 rounded-md px-3 text-ui aria-pressed:border-foreground/40 aria-pressed:bg-foreground/[0.06]"
                    key={option.label}
                    onClick={() => setInstant(option.at)}
                    size={null}
                    type="button"
                    variant="outline"
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <div
            className="grid gap-0.5 rounded-lg bg-foreground/[0.04] px-4 py-3"
            data-testid="schedule-summary"
          >
            <p className="text-ui-lg font-medium text-foreground">{headline}</p>
            {chosen ? (
              <p className="text-xs text-muted-foreground">
                {queue ? 'Next free slot · ' : ''}
                {zone} · {offsetLabel(chosen, zone)}
                {natural ? ' · ± up to 4 minutes' : ''}
              </p>
            ) : null}
            {chosen && localZone && localZone !== zone ? (
              <p className="text-xs text-muted-foreground">
                Your time:{' '}
                {formatWhen(chosen, localZone)} · {localZone.replaceAll('_', ' ')}
              </p>
            ) : null}
          </div>
          {past && !queue ? (
            <p className="text-xs text-red-700 dark:text-red-300">That time has passed.</p>
          ) : null}
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
        </section>
        <Destinations context={context} />
        <MoreOptions>
          {data.advancedScheduling ? (
            <>
              <div className="grid gap-2">
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
                  placeholder='Type a time, like "fri 2pm"'
                  value={when}
                />
                {when ? (
                  <p className="text-xs text-muted-foreground" data-testid="when-reading">
                    {readWhen(when, zone)
                      ? `→ ${summary}`
                      : `Could not read that time. Still selected: ${summary}.`}
                  </p>
                ) : null}
              </div>
              <TimeChips
                chosen={instant}
                heading="Suggested times"
                onPick={setInstant}
                times={bestTimes.map((best) => ({ at: new Date(best.at), title: best.reason }))}
                zone={zone}
              />
              <div className="grid gap-2">
                <Button
                  className="h-7 w-fit px-0 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setBrowsing(!browsing)}
                  size={null}
                  type="button"
                  variant="custom"
                >
                  {browsing ? 'Hide queue' : 'Browse queue'}
                </Button>
                {browsing ? (
                  <ul
                    className="grid max-h-48 overflow-y-auto rounded-md border border-border text-xs"
                    data-testid="queue-slots"
                  >
                    {slots.length === 0 ? (
                      <li className="px-3 py-2 text-muted-foreground">
                        No weekly slots: add them in the set’s scheduling settings.
                      </li>
                    ) : null}
                    {slots.map((slot) => (
                      <li
                        className="flex min-h-9 items-center justify-between gap-3 border-b border-border px-3 last:border-b-0"
                        key={slot.at.toISOString()}
                      >
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
                            className="h-7 px-2 text-xs"
                            onClick={() => setInstant(slot.at)}
                            size={null}
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
              </div>
              <Label className="flex items-center justify-between gap-4 text-sm font-normal">
                <span className="grid gap-0.5">
                  Natural posting time
                  <span className="text-xs text-muted-foreground">
                    Moves it up to 4 minutes off the round minute.
                  </span>
                </span>
                <Switch
                  aria-label="Natural posting time"
                  checked={natural}
                  onCheckedChange={(checked) => setNatural(checked === true)}
                />
              </Label>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              <a href="/pricing" className="underline underline-offset-2">
                Upgrade to Pro
              </a>{' '}
              for queue slots, suggested times and automatic follow-ups.
            </p>
          )}
          <FollowUps context={context} publishAt={chosen ?? now} timeZone={zone} />
        </MoreOptions>
        <ReplacedPosts context={context} timeZone={zone} />
        <Problems context={context} problems={problems} />
        <ActionError message={error} />
        {planBlocked ? (
          <p className="text-xs text-muted-foreground" role="status">
            {planBlocked}
          </p>
        ) : null}
        <div className="grid gap-4 border-t border-border pt-5">
          <Label className="flex w-fit items-center gap-2 text-xs font-normal text-muted-foreground">
            <Checkbox
              checked={continueWriting}
              onCheckedChange={(checked) => setContinueWriting(checked === true)}
            />
            Open a new draft after scheduling
          </Label>
          <div className="flex flex-wrap items-center justify-end gap-2">
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
            {onPreview ? (
              <Button onClick={onPreview} type="button" variant="ghost">
                Preview
              </Button>
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
              title="Keeps it on the calendar without publishing"
              type="button"
              variant="outline"
            >
              {action === 'plan' ? 'Saving…' : 'Save as planned'}
            </Button>
            <Button
              className="w-full sm:w-auto"
              disabled={!confirmable}
              onClick={() => void schedule()}
              title="Confirm (⌘↵)"
              type="button"
            >
              {action === 'schedule'
                ? 'Scheduling…'
                : queue
                  ? rescheduling
                    ? 'Reschedule to next free slot'
                    : 'Add to queue'
                  : rescheduling
                    ? 'Confirm reschedule'
                    : 'Confirm schedule'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Settings most schedules never touch, folded away so the dialog stays short. */
function MoreOptions({ children }: { children: React.ReactNode }) {
  return (
    <Disclosure className="rounded-lg border border-border">
      <DisclosureTrigger className="rounded-lg px-4 py-3 text-sm text-foreground select-none hover:bg-foreground/[0.03]">
        More options
      </DisclosureTrigger>
      <DisclosureContent className="grid gap-5 border-t border-border p-4">{children}</DisclosureContent>
    </Disclosure>
  )
}

/** The X version's follow-ups: Auto-DM, and on Pro, Auto-RT and Auto-Plug. */
function FollowUps({
  context,
  publishAt,
  timeZone,
}: {
  context: ScheduleContext
  publishAt: Date
  timeZone: string
}) {
  const { data } = useWrite()
  if (!context.items.some((item) => item.account.channel === 'x')) return null
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">X follow-ups</p>
        <AutoDmDraft
          value={context.autoDm}
          onChange={(next) => context.onAutoDm?.(next)}
          readOnly={!context.onAutoDm}
        />
      </div>
      {data.advancedScheduling ? (
        <AutomationControls
          automation={context.automation}
          onChange={(next) => context.onAutomation?.(next)}
          publishAt={publishAt}
          readOnly={!context.onAutomation}
          setId={
            context.draft.socialSetId ??
            data.sets.find((set) => set.visibility === 'WORKSPACE')?.id ??
            null
          }
          timeZone={timeZone}
        />
      ) : null}
    </div>
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
function Destinations({ context }: { context: ScheduleContext }) {
  const { data } = useWrite()
  const setId =
    context.draft.socialSetId ?? data.sets.find((set) => set.visibility === 'WORKSPACE')?.id
  const set = data.sets.find((item) => item.id === setId)
  if (!set) return null
  const on = new Set(context.items.map((item) => item.account.id))
  return (
    <fieldset className="grid gap-3" data-testid="destinations">
      <legend className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
        Post to <SetDot color={set.color} /> {set.name}
      </legend>
      <div className="grid divide-y divide-border rounded-lg border border-border">
        {set.accounts.map((account) => (
          <Label
            className="flex min-h-11 items-center gap-3 px-4 py-2 text-sm font-normal"
            key={account.id}
          >
            <ChannelIcon channel={account.channel} className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              {account.displayName ?? account.handle ?? CHANNEL_META[account.channel].label}
              {account.handle ? (
                <span className="ml-1.5 text-xs text-muted-foreground">@{account.handle}</span>
              ) : null}
              {account.health !== 'connected' ? (
                <span className="ml-1.5 text-xs text-amber-700 dark:text-amber-300">
                  {healthLabel(account.health).toLowerCase()}
                </span>
              ) : null}
            </span>
            <Switch
              aria-label={`Publish to ${CHANNEL_META[account.channel].label}`}
              checked={on.has(account.id)}
              disabled={
                platformRefusal(account.channel, context.kind, on.has(account.id), on.size) !== null
              }
              onCheckedChange={(checked) => context.onToggle(account.id, checked === true)}
            />
          </Label>
        ))}
      </div>
      <CommunityTimeline context={context} />
    </fieldset>
  )
}

/**
 * The draft's queued posts that confirming replaces, one line per
 * destination: a schedule replaces them all, so a destination switched off
 * here is cancelled rather than left at its old time.
 */
function ReplacedPosts({
  context,
  publishNow = false,
  timeZone,
}: {
  context: ScheduleContext
  /** Publish now sends the replacement at once instead of at a new time. */
  publishNow?: boolean
  timeZone: string
}) {
  const { data } = useWrite()
  const scheduled = context.scheduled ?? []
  if (scheduled.length === 0) return null
  const selected = new Set(context.items.map((item) => item.account.id))
  const accounts = new Map(
    data.sets.flatMap((set) => set.accounts.map((account) => [account.id, account] as const))
  )
  return (
    <div
      className="grid gap-2 rounded-lg border border-amber-400/40 bg-amber-500/[0.04] px-4 py-3 text-xs"
      data-testid="replaced-posts"
    >
      <p className="text-foreground">
        Confirming replaces{' '}
        {scheduled.length === 1 ? 'the queued post' : `all ${scheduled.length} queued posts`} of
        this draft:
      </p>
      <ul className="grid gap-1">
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
                <LocalTime value={post.scheduledFor} zone={timeZone} />
              </span>
              {selected.has(post.channelConnectionId) ? (
                <span className="text-muted-foreground">
                  {publishNow ? '→ publishes now instead' : '→ moves to the new time'}
                </span>
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
    <div
      className="grid gap-2 rounded-lg border border-red-500/30 bg-red-500/[0.04] px-4 py-3"
      data-testid="blocking-problems"
      role="alert"
    >
      <ul className="grid gap-1">
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
      className="rounded-lg border border-red-500/30 bg-red-500/[0.04] px-4 py-3 text-xs text-red-700 dark:text-red-300"
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
        className="max-h-[92dvh] max-w-[calc(100%-1rem)] gap-6 overflow-y-auto p-5 sm:max-w-lg sm:p-6"
        data-testid="publish-review"
      >
        <DialogHeader className="gap-1.5 text-left">
          <DialogTitle>Publish now</DialogTitle>
          <DialogDescription className="text-xs">
            Check what goes where. Nothing is sent until you confirm.
          </DialogDescription>
        </DialogHeader>
        <section aria-label="Destinations" className="grid gap-3">
          {set ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Publishing as <SetDot color={set.color} />
              <span className="text-foreground">{set.name}</span>
            </p>
          ) : null}
          <ul className="grid gap-3">
            {context.items.map(({ account, publication }) => {
              const posts = publication.serialized.posts
              const media = posts.reduce((total, post) => total + post.images, 0)
              const first = publication.target.options
              return (
                <li
                  className="grid gap-2 rounded-lg border border-border px-4 py-3 text-sm"
                  data-testid="review-destination"
                  key={account.id}
                >
                  <p className="flex items-center gap-2 text-foreground">
                    <ChannelIcon
                      channel={account.channel}
                      className="size-4 text-muted-foreground"
                    />
                    {account.displayName ?? CHANNEL_META[account.channel].label}
                    {account.handle ? (
                      <span className="text-xs text-muted-foreground">@{account.handle}</span>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
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
                  <p className="line-clamp-4 whitespace-pre-wrap text-sm text-foreground">
                    {posts[0]?.caption}
                  </p>
                  {publication.problems.map((problem) => (
                    <p className="text-xs text-red-700 dark:text-red-300" key={problem}>
                      {problem}
                    </p>
                  ))}
                </li>
              )
            })}
          </ul>
          <CommunityTimeline context={context} />
        </section>
        {followUps.length > 0 ? (
          <div className="grid gap-1 text-xs text-muted-foreground">
            <p className="text-foreground">After it is live</p>
            <ul className="grid gap-0.5">
              {followUps.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {context.items.some((item) => item.account.channel === 'x') ? (
          <MoreOptions>
            <FollowUps
              context={context}
              publishAt={new Date()}
              timeZone={context.setTimeZone ?? 'UTC'}
            />
          </MoreOptions>
        ) : null}
        <ReplacedPosts context={context} publishNow timeZone={context.setTimeZone ?? 'UTC'} />
        <Problems context={context} problems={problems} />
        <ActionError message={error} />
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-5">
          <p className="mr-auto text-xs text-muted-foreground">
            {context.requireApproval
              ? context.approved
                ? 'Approved at this version.'
                : 'Not approved at this version.'
              : 'No approval needed.'}
            {context.canPublish ? '' : ' You cannot publish.'}
          </p>
          <Button onClick={onPreview} type="button" variant="ghost">
            Preview
          </Button>
          <Button onClick={onClose} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            className="w-full sm:w-auto"
            disabled={busy || problems.length > 0}
            onClick={() => void publish()}
            type="button"
          >
            {busy ? 'Publishing…' : 'Publish now'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** A row of times to pick from, each read in the brand's zone. */
function TimeChips({
  chosen,
  heading,
  onPick,
  testId,
  times,
  zone,
}: {
  chosen: Date | null
  heading: string
  onPick: (at: Date) => void
  testId?: string
  times: { at: Date; title?: string }[]
  zone: string
}) {
  if (times.length === 0) return null
  return (
    <div className="grid gap-2" data-testid={testId}>
      <p className="text-xs text-muted-foreground">{heading}</p>
      <div className="flex flex-wrap gap-2">
        {times.map(({ at, title }) => (
          <Button
            aria-pressed={chosen?.getTime() === at.getTime()}
            className="h-8 rounded-md px-3 text-ui aria-pressed:border-foreground/40 aria-pressed:bg-foreground/[0.06]"
            key={at.toISOString()}
            onClick={() => onPick(at)}
            size={null}
            title={title}
            type="button"
            variant="outline"
          >
            {at.toLocaleString(undefined, {
              hour: 'numeric',
              minute: '2-digit',
              timeZone: zone,
              weekday: 'short',
            })}
          </Button>
        ))}
      </div>
    </div>
  )
}
