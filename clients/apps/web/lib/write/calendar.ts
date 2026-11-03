import { resolveLocalTime, wallTime } from './zoned-time'

/** Dragging an authored draft opens scheduling review; it never creates a job. */
export const CALENDAR_DRAFT_DRAG = 'application/x-shots-calendar-draft'

/** A move never guesses which occurrence of an ambiguous local time was intended. */
export function calendarMoveTime(day: string, clock: string, zone: string): Date {
  const time = resolveLocalTime(`${day}T${clock}`, zone)
  if (time.kind !== 'exact')
    throw new Error(
      'This time is skipped or repeated by daylight saving. Choose a time in the schedule dialog.'
    )
  return time.at
}

/** Free future slots on a calendar day; repeated or skipped wall times need manual review. */
export function availableDaySlots(
  day: string,
  zone: string,
  slots: { weekday: number; time: string }[],
  taken: string[],
  now = new Date()
): string[] {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay()
  return [...new Set(slots.filter((slot) => slot.weekday === weekday).map((slot) => slot.time))]
    .filter((time) => {
      const resolved = resolveLocalTime(`${day}T${time}`, zone)
      return (
        resolved.kind === 'exact' &&
        resolved.at > now &&
        !taken.some((at) => Math.abs(new Date(at).getTime() - resolved.at.getTime()) < 5 * 60_000)
      )
    })
    .sort()
}

/**
 * The next weekly slots in a brand's zone, up to 12 in three weeks, marking
 * those a queued post already takes. Repeated or skipped wall times are left
 * out, as on the calendar.
 */
export function upcomingSlots(
  postingSlots: { time: string; weekday: number }[],
  zone: string,
  taken: string[],
  now = new Date()
): { at: Date; busy: boolean }[] {
  const out: { at: Date; busy: boolean }[] = []
  for (let days = 0; days < 21 && out.length < 12; days += 1) {
    const day = wallTime(new Date(now.getTime() + days * 86_400_000), zone).slice(0, 10)
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay()
    for (const slot of postingSlots.filter((item) => item.weekday === weekday)) {
      const resolved = resolveLocalTime(`${day}T${slot.time}`, zone)
      if (resolved.kind !== 'exact' || resolved.at <= now) continue
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

/** Visible calendar days, including adjacent weeks in month view. */
export function calendarRange(anchor: string, view: 'week' | 'month' | 'queue', firstWeekday = 1) {
  const parsed = new Date(`${anchor}T12:00:00Z`)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(anchor) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== anchor
  ) {
    throw new Error('Choose a valid calendar date.')
  }
  const start = new Date(parsed)
  if (view === 'month') start.setUTCDate(1)
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() - firstWeekday + 7) % 7))
  const days = view === 'month' ? 42 : 7
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + days)
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), days }
}

/** Navigate months from their first day so January 31 never skips February. */
export function shiftCalendar(
  anchor: string,
  view: 'week' | 'month' | 'queue',
  delta: number
): string {
  const date = new Date(`${anchor}T12:00:00Z`)
  if (view === 'month') {
    date.setUTCDate(1)
    date.setUTCMonth(date.getUTCMonth() + delta)
  } else date.setUTCDate(date.getUTCDate() + delta * 7)
  return date.toISOString().slice(0, 10)
}
