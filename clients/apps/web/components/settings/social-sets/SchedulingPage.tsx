'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { LocalTime, WHEN_STYLE } from '@/components/drafts/local-time'
import { Group, Row } from '@/components/platform-ui'
import { SaveStatus, useSaveState } from '@/components/settings/controls'
import { usePreferences } from '@/components/settings/PreferencesProvider'
import { TimeZonePicker } from '@/components/settings/TimeZonePicker'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useTwelveHour } from '@/components/ui/format-preferences'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { TimePicker } from '@/components/ui/time-picker'
import { POSTING_SLOT_LIMIT } from '@/lib/api/contracts/social-sets'
import { naturalWindow } from '@/lib/plan/calendar'
import { formatTimeOfDay } from '@/lib/time-of-day'
import { upcomingSlots } from '@/lib/write/calendar'
import { type SocialSetRecord, useSaveSocialSet } from './api'

type Slot = SocialSetRecord['postingSlots'][number]

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
const CLOCK: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' }

/** The weekly count: every enabled day and time, not just the rows. */
export function weeklySlotCount(slots: Slot[]): number {
  return new Set(slots.map((slot) => `${slot.weekday} ${slot.time}`)).size
}

/**
 * A set's schedule (RFC 024): its time zone, the weekly grid of posting times
 * the queue fills, and natural posting times. The grid is a template: changing
 * it never moves a post that is already scheduled.
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
  const pending = useRef(0)
  const [gridState, runGrid] = useSaveState()
  const [zoneState, runZone] = useSaveState()
  const [naturalState, runNatural] = useSaveState()
  const [adding, setAdding] = useState('')
  const twelveHour = useTwelveHour()
  const readableTime = (time: string) => formatTimeOfDay(time, twelveHour)
  // A time whose last weekday was unticked keeps its row until it is removed.
  const [kept, setKept] = useState<string[]>([])

  // A save confirmed elsewhere, or a reload, brings the server's grid back.
  useEffect(() => {
    if (pending.current === 0) setSlots(set.postingSlots)
  }, [set.postingSlots])

  const times = useMemo(() => [...new Set([...slots.map((slot) => slot.time), ...kept])].sort(), [slots, kept])
  const count = weeklySlotCount(slots)
  const next = upcomingSlots(set.postingSlots, set.timeZone, []).slice(0, 3)
  const enabled = (weekday: number, time: string) => slots.some((slot) => slot.weekday === weekday && slot.time === time)

  const commit = (next: Slot[]) => {
    setSlots(next)
    pending.current += 1
    void runGrid(async () => {
      const result = await save({ postingSlots: next })
      pending.current -= 1
      if (!result.ok && pending.current === 0) setSlots(set.postingSlots)
      return result
    })
  }

  const toggle = (weekday: number, time: string, on: boolean) => {
    if (!on) setKept((current) => [...new Set([...current, time])])
    commit(on ? [...slots, { time, weekday }] : slots.filter((slot) => !(slot.weekday === weekday && slot.time === time)))
  }
  const removeTime = (time: string) => {
    setKept((current) => current.filter((item) => item !== time))
    commit(slots.filter((slot) => slot.time !== time))
  }
  // A new time takes Monday to Friday, so it needs five free slots.
  const full = count + 5 > POSTING_SLOT_LIMIT
  const addTime = () => {
    if (!adding || times.includes(adding) || full) return
    commit([...slots, ...[1, 2, 3, 4, 5].map((weekday) => ({ time: adding, weekday }))])
    setAdding('')
  }

  return (
    <div className="grid gap-6">
      <Group>
        <Row
          description="Every time for this publishing brand reads in this zone: its queue, slots and calendar. Changing it keeps each weekly slot's clock time in the new zone; posts already scheduled keep their time."
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
          description="Add to queue takes the next free time here. Editing the schedule does not change posts already scheduled."
          label={
            <span className="flex items-center gap-2">
              Weekly posting times <SaveStatus state={gridState} />
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
                <TableCaption className="sr-only">Posting times by weekday in {set.timeZone}</TableCaption>
                <TableHeader>
                  <TableRow className="text-xs text-muted-foreground">
                    <TableHead className="py-2 text-left font-medium text-muted-foreground" scope="col">
                      Time
                    </TableHead>
                    {days.map((day) => (
                      <TableHead className="py-2 text-center font-medium text-muted-foreground" key={day} scope="col">
                        <abbr title={DAY_NAMES[day]}>{DAY_NAMES[day]!.slice(0, 3)}</abbr>
                      </TableHead>
                    ))}
                    <TableHead className="sr-only" scope="col">
                      Remove
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {times.length === 0 ? (
                    <TableRow>
                      <TableCell className="py-4 text-muted-foreground whitespace-normal" colSpan={9}>
                        No posting times yet. The queue has nowhere to place drafts until you add one.
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
                            disabled={!canManage || (!enabled(day, time) && count >= POSTING_SLOT_LIMIT)}
                            onCheckedChange={(checked) => toggle(day, time, checked === true)}
                          />
                        </TableCell>
                      ))}
                      <TableCell className="py-2 text-right">
                        <Button
                          aria-label={`Remove ${readableTime(time)}`}
                          disabled={!canManage}
                          onClick={() => removeTime(time)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Remove
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
                <TimePicker aria-label="Time to add" disabled={!canManage} onChange={setAdding} value={adding} />
                <Button disabled={!canManage || !adding || full} type="submit" variant="outline">
                  Add time
                </Button>
              </form>
              <p aria-live="polite" className="text-sm text-foreground" data-testid="weekly-slot-count">
                {count} of {POSTING_SLOT_LIMIT} weekly posting slots
                {full && canManage ? (
                  <span className="block text-xs text-muted-foreground">
                    A new time takes five slots (Monday to Friday). Remove some to add another.
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
                    <LocalTime options={{ ...WHEN_STYLE, weekday: 'short' }} value={at} zone={set.timeZone} />
                    {set.naturalPostingTimes ? (
                      <>
                        {' '}
                        (goes out <LocalTime options={CLOCK} value={naturalWindow(at).from} zone={set.timeZone} />–
                        <LocalTime options={CLOCK} value={naturalWindow(at).to} zone={set.timeZone} />)
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
          description="New drafts start with posts going out up to four minutes either side of the slot, so they read less like a timer. The offset is chosen once and kept, and you can turn it off for one draft when you schedule it."
          label="Natural posting times"
          layout="inline"
        >
          <div className="flex items-center gap-3">
            <SaveStatus state={naturalState} />
            <Switch
              aria-label="Natural posting times for new drafts"
              checked={set.naturalPostingTimes}
              disabled={!canManage}
              onCheckedChange={(naturalPostingTimes) => void runNatural(() => save({ naturalPostingTimes }))}
            />
          </div>
        </Row>
      </Group>
    </div>
  )
}
