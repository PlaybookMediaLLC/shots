/**
 * Plain-language schedule times for the composer: "tomorrow 9am", "in 3
 * hours", "fri 2:30pm", "oct 21 at noon". Times are local to the browser. A
 * day without a time means 9:00; a time alone means its next occurrence.
 */

import { parseTimeOfDay } from '@/lib/time-of-day'

const UNITS: Record<string, number> = {
  d: 86_400_000,
  day: 86_400_000,
  h: 3_600_000,
  hour: 3_600_000,
  hr: 3_600_000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  w: 604_800_000,
  week: 604_800_000,
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** "9", "9am", "9:30pm", "21:00", "noon", "midnight" as [hours, minutes]. */
function parseTime(text: string): [number, number] | null {
  const time = parseTimeOfDay(text)
  return time ? [Number(time.slice(0, 2)), Number(time.slice(3))] : null
}

function at(day: Date, [hours, minutes]: [number, number]): Date {
  const result = new Date(day)
  result.setHours(hours, minutes, 0, 0)
  return result
}

/** The time `input` names, from `now`; null when it is not one this reads. */
export function parseWhen(input: string, now: Date = new Date()): Date | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ').replace(/,/g, '')
  if (!text) return null

  const relative = /^in (\d+|an?|one) ([a-z]+?)s?$/.exec(text)
  if (relative) {
    const amount = /^\d+$/.test(relative[1]) ? Number(relative[1]) : 1
    const unit = UNITS[relative[2]]
    return unit ? new Date(now.getTime() + amount * unit) : null
  }

  // Split "<day> [at] <time>" at the time, if there is one.
  const parts =
    /^(.*?)(?:\s*(?:at|@)\s*|\s+|^)(\d{1,2}(?::\d{2})?\s*(?:am|pm|a|p)?|noon|midnight)$/.exec(text)
  const dayText = (parts ? parts[1] : text).trim()
  const time = parts ? parseTime(parts[2]) : null
  if (parts && !time) return null
  const clock = time ?? [9, 0]

  const today = new Date(now)
  if (!dayText) {
    if (!time) return null
    const candidate = at(today, time)
    if (candidate > now) return candidate
    candidate.setDate(candidate.getDate() + 1)
    return candidate
  }
  if (dayText === 'today' || dayText === 'tonight') {
    return at(today, time ?? (dayText === 'tonight' ? [20, 0] : clock))
  }
  if (dayText === 'tomorrow' || dayText === 'tmrw') {
    today.setDate(today.getDate() + 1)
    return at(today, clock)
  }

  const weekday = /^(next )?([a-z]+)$/.exec(dayText)
  const index = weekday ? WEEKDAYS.indexOf(weekday[2].slice(0, 3)) : -1
  if (weekday && index >= 0 && weekday[2].length >= 3) {
    let ahead = (index - today.getDay() + 7) % 7
    if (ahead === 0 && (weekday[1] || at(today, clock) <= now)) ahead = 7
    today.setDate(today.getDate() + ahead)
    return at(today, clock)
  }

  // "oct 21", "21 oct", "10/21": the next such date.
  const named = /^([a-z]+) (\d{1,2})$/.exec(dayText) ?? /^(\d{1,2}) ([a-z]+)$/.exec(dayText)
  const slashed = /^(\d{1,2})\/(\d{1,2})$/.exec(dayText)
  let month = -1
  let date = 0
  if (named) {
    const [word, number] = /^\d/.test(named[1]) ? [named[2], named[1]] : [named[1], named[2]]
    month = MONTHS.indexOf(word.slice(0, 3))
    date = Number(number)
  } else if (slashed) {
    month = Number(slashed[1]) - 1
    date = Number(slashed[2])
  }
  if (month < 0 || month > 11 || date < 1 || date > 31) return null
  const candidate = at(new Date(today.getFullYear(), month, date), clock)
  if (candidate.getMonth() !== month) return null
  if (candidate <= now) candidate.setFullYear(candidate.getFullYear() + 1)
  return candidate
}
