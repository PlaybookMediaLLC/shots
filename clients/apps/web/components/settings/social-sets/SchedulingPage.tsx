'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { LocalTime, WHEN_STYLE } from '@/components/drafts/local-time'
import { AddIcon, CloseIcon } from '@/components/platform-shell/icons'
import { Group, Pill, Row } from '@/components/platform-ui'
import { SaveStatus, useSaveState } from '@/components/settings/controls'
import { usePreferences } from '@/components/settings/PreferencesProvider'
import { TimeZonePicker } from '@/components/settings/TimeZonePicker'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useTwelveHour } from '@/components/ui/format-preferences'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { TimePicker } from '@/components/ui/time-picker'
import { POSTING_SLOT_LIMIT } from '@/lib/api/contracts/social-sets'
import { naturalWindow } from '@/lib/plan/calendar'
import { formatTimeOfDay } from '@/lib/time-of-day'
import { upcomingSlots } from '@/lib/write/calendar'
import { type SocialSetRecord, useSaveSocialSet } from './api'

type Slot = SocialSetRecord['postingSlots'][number]

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const
const CLOCK: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }
const PRESET_WINDOWS = [4, 5, 10, 15] as const
const DEFAULT_SUGGESTED_TIMES = ['09:00', '12:00', '15:00', '18:00', '10:00', '14:00', '17:00']

function suggestNextTime(existing: string[]): string {
  const taken = new Set(existing)
  for (const candidate of DEFAULT_SUGGESTED_TIMES) {
    if (!taken.has(candidate)) return candidate
  }
  for (let hour = 8; hour < 22; hour++) {
    for (const minute of [0, 30]) {
      const candidate = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
      if (!taken.has(candidate)) return candidate
    }
  }
  return '09:30'
}

/** The weekly count: every enabled day and time, not just the rows. */
export function weeklySlotCount(slots: Slot[]): number {
  return new Set(slots.map((slot) => `${slot.weekday} ${slot.time}`)).size
}

/**
 * A set's schedule (RFC 024): its time zone, the weekly grid of posting times
 * the queue fills, and randomized posting time windows. The grid is a template:
 * changing it never moves a post that is already scheduled.
 */
export function SchedulingPage({
  advancedScheduling,
  canManage: canManageSet,
  set,
}: {
  /** Whether the plan has queue slots; unknown (undefined) leaves the backend to say. */
  advancedScheduling?: boolean
  canManage: boolean
  set: SocialSetRecord
}) {
  const locked = advancedScheduling === false
  const canManage = canManageSet && !locked
  const save = useSaveSocialSet(set.id)
  const weekStart = usePreferences().preferences?.weekStart ?? 'monday'
  const days = weekStart === 'monday' ? [1, 2, 3, 4, 5, 6, 0] : [0, 1, 2, 3, 4, 5, 6]
  const [slots, setSlots] = useState<Slot[]>(set.postingSlots)
  const latestSlots = useRef<Slot[]>(set.postingSlots)
  const pending = useRef(0)
  const [gridState, runGrid] = useSaveState()
  const [zoneState, runZone] = useSaveState()
  const [naturalState, runNatural] = useSaveState()
  // A time whose last weekday was unticked keeps its row until it is removed.
  const [kept, setKept] = useState<string[]>([])
  const times = useMemo(
    () => [...new Set([...slots.map((slot) => slot.time), ...kept])].sort(),
    [slots, kept]
  )
  const [adding, setAdding] = useState(() => suggestNextTime(set.postingSlots.map((s) => s.time)))
  const twelveHour = useTwelveHour()
  const readableTime = (time: string) => formatTimeOfDay(time, twelveHour)

  // A save confirmed elsewhere, or a reload, brings the server's grid back.
  useEffect(() => {
    latestSlots.current = set.postingSlots
    if (pending.current === 0) setSlots(set.postingSlots)
  }, [set.postingSlots])

  const slotSet = useMemo(() => new Set(slots.map((slot) => `${slot.weekday} ${slot.time}`)), [slots])
  const count = slotSet.size
  const remaining = Math.max(0, POSTING_SLOT_LIMIT - count)
  const windowMinutes = set.naturalPostingWindowMinutes ?? 10
  const windowChoices = useMemo(() => {
    const values = new Set<number>(PRESET_WINDOWS)
    if (windowMinutes >= 1 && windowMinutes <= 15) values.add(windowMinutes)
    return [...values].sort((a, b) => a - b)
  }, [windowMinutes])

  const next = useMemo(
    () => upcomingSlots(set.postingSlots, set.timeZone, []).slice(0, 3),
    [set.postingSlots, set.timeZone]
  )
  const enabled = (weekday: number, time: string) => slotSet.has(`${weekday} ${time}`)

  const commit = (nextSlots: Slot[]) => {
    setSlots(nextSlots)
    pending.current += 1
    void runGrid(async () => {
      try {
        const result = await save({ postingSlots: nextSlots })
        if (!result.ok && pending.current === 1) setSlots(latestSlots.current)
        return result
      } finally {
        pending.current = Math.max(0, pending.current - 1)
      }
    })
  }

  const toggle = (weekday: number, time: string, on: boolean) => {
    if (!on) setKept((current) => [...new Set([...current, time])])
    commit(
      on
        ? [...slots, { time, weekday }]
        : slots.filter((slot) => !(slot.weekday === weekday && slot.time === time))
    )
  }
  const removeTime = (time: string) => {
    setKept((current) => current.filter((item) => item !== time))
    commit(slots.filter((slot) => slot.time !== time))
  }
  // Fill Monday–Friday up to the remaining slot budget so rows can still be added near the 50-slot cap.
  const full = remaining === 0
  const addTime = () => {
    if (!adding || times.includes(adding) || full) return
    const weekdaysToEnable = [1, 2, 3, 4, 5].slice(0, remaining)
    const nextSlots = [...slots, ...weekdaysToEnable.map((weekday) => ({ time: adding, weekday }))]
    commit(nextSlots)
    setAdding(suggestNextTime([...times, adding]))
  }

  return (
    <div className="grid gap-6">
      <Group>
        <Row
          description="Applies to its queue, slots and calendar. Scheduled posts keep their time."
          label={
            <span className="flex items-center gap-2">
              Time zone <SaveStatus state={zoneState} />
            </span>
          }
          layout="stacked"
        >
          <TimeZonePicker
            disabled={!canManageSet}
            hideLabel
            label="Time zone"
            onChange={(timeZone) => void runZone(() => save({ timeZone }))}
            value={set.timeZone}
          />
        </Row>
      </Group>

      <Group>
        <Row
          description="Add to queue takes the next free time here. Scheduled posts stay as they are."
          label={
            <span className="flex flex-wrap items-center gap-2">
              Weekly posting times
              <Pill>
                {count} / {POSTING_SLOT_LIMIT} slots
              </Pill>
              <SaveStatus state={gridState} />
            </span>
          }
          layout="stacked"
        >
          <div className="grid w-full min-w-0 gap-3">
            {locked ? (
              <p className="text-sm text-muted-foreground" data-testid="slots-locked">
                <a className="underline" href="/pricing">
                  Upgrade to Pro
                </a>{' '}
                for queue slots, suggested times and automatic follow-ups.
              </p>
            ) : null}
            <div className="overflow-x-auto">
              <Table className="w-full min-w-[28rem] text-sm">
                <TableCaption className="sr-only">
                  Posting times by weekday in {set.timeZone}
                </TableCaption>
                <TableHeader>
                  <TableRow className="text-xs text-muted-foreground">
                    <TableHead
                      className="py-2 text-left font-medium text-muted-foreground"
                      scope="col"
                    >
                      Time
                    </TableHead>
                    {days.map((day) => (
                      <TableHead
                        className="py-2 text-center font-medium text-muted-foreground"
                        key={day}
                        scope="col"
                      >
                        <abbr title={DAY_NAMES[day]}>{DAY_NAMES[day]!.slice(0, 3)}</abbr>
                      </TableHead>
                    ))}
                    <TableHead className="w-10 text-right" scope="col">
                      <span className="sr-only">Remove</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {times.length === 0 ? (
                    <TableRow>
                      <TableCell
                        className="py-4 text-muted-foreground whitespace-normal"
                        colSpan={9}
                      >
                        No posting times yet. The queue has nowhere to place drafts until you add
                        one.
                      </TableCell>
                    </TableRow>
                  ) : null}
                  {times.map((time) => (
                    <TableRow className="border-t border-border" key={time}>
                      <TableHead className="py-2 text-left font-medium text-foreground" scope="row">
                        {readableTime(time)}
                      </TableHead>
                      {days.map((day) => (
                        <TableCell className="py-2 text-center" key={day}>
                          <Checkbox
                            aria-label={`${DAY_NAMES[day]} at ${readableTime(time)}`}
                            checked={enabled(day, time)}
                            disabled={
                              !canManage || (!enabled(day, time) && count >= POSTING_SLOT_LIMIT)
                            }
                            onCheckedChange={(checked) => toggle(day, time, checked === true)}
                          />
                        </TableCell>
                      ))}
                      <TableCell className="py-2 text-right">
                        <Button
                          aria-label={`Remove ${readableTime(time)}`}
                          disabled={!canManage}
                          onClick={() => removeTime(time)}
                          size="icon"
                          title={`Remove ${readableTime(time)}`}
                          type="button"
                          variant="ghost"
                        >
                          <CloseIcon className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  addTime()
                }}
              >
                <TimePicker
                  aria-label="Time to add"
                  disabled={!canManage || full}
                  onChange={setAdding}
                  value={adding}
                />
                <Button
                  disabled={!canManage || !adding || times.includes(adding) || full}
                  type="submit"
                  variant="outline"
                >
                  <AddIcon className="mr-1.5 size-4" />
                  Add time
                </Button>
              </form>
              <p
                aria-live="polite"
                className="text-sm text-foreground"
                data-testid="weekly-slot-count"
              >
                {count} of {POSTING_SLOT_LIMIT} weekly posting slots
                {full && canManage ? (
                  <span className="block text-xs text-muted-foreground">
                    Weekly slot limit reached. Remove a slot to add another time.
                  </span>
                ) : null}
              </p>
            </div>
            {next.length > 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="upcoming-slots">
                Next slots:{' '}
                {next.map(({ at }, index) => (
                  <span key={at.toISOString()}>
                    {index > 0 ? ' · ' : null}
                    <LocalTime
                      options={{ ...WHEN_STYLE, weekday: 'short' }}
                      value={at}
                      zone={set.timeZone}
                    />
                    {set.naturalPostingTimes ? (
                      <>
                        {' '}
                        (goes out{' '}
                        <LocalTime
                          options={CLOCK}
                          value={naturalWindow(at, windowMinutes).from}
                          zone={set.timeZone}
                        />
                        –
                        <LocalTime
                          options={CLOCK}
                          value={naturalWindow(at, windowMinutes).to}
                          zone={set.timeZone}
                        />
                        )
                      </>
                    ) : null}
                  </span>
                ))}
              </p>
            ) : null}
          </div>
        </Row>
      </Group>

      <Group>
        <Row
          description={`New drafts go out within ±${windowMinutes} minute${windowMinutes === 1 ? '' : 's'} of their scheduled slot so they look natural instead of landing on exact clock ticks. Chosen once per post; already-scheduled posts keep their time.`}
          label={
            <span className="flex items-center gap-2">
              Randomize posting time <SaveStatus state={naturalState} />
            </span>
          }
          layout="inline"
        >
          <div className="flex flex-wrap items-center gap-3">
            {set.naturalPostingTimes ? (
              <Select
                disabled={!canManage}
                onValueChange={(value) =>
                  void runNatural(() => save({ naturalPostingWindowMinutes: Number(value) }))
                }
                value={String(windowMinutes)}
              >
                <SelectTrigger aria-label="Randomize posting window" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {windowChoices.map((minutes) => (
                    <SelectItem key={minutes} value={String(minutes)}>
                      ±{minutes} min
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Switch
              aria-label="Randomize posting time for new drafts"
              checked={set.naturalPostingTimes}
              disabled={!canManage}
              onCheckedChange={(naturalPostingTimes) =>
                void runNatural(() => save({ naturalPostingTimes }))
              }
            />
          </div>
        </Row>
      </Group>
    </div>
  )
}
