import { addDays, format, isValid, parse } from 'date-fns'

/** A local Date as YYYY-MM-DD. */
export function dayKey(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}

/** A YYYY-MM-DD day as a local Date at noon, so no zone moves it a day. */
export function dayDate(day: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date, 12)
}

/** The forms a typed day takes, tried in order; a missing year means this year. */
const DAY_FORMATS = [
  'yyyy-MM-dd',
  'M/d/yyyy',
  'M/d/yy',
  'M/d',
  'MMM d yyyy',
  'MMM d',
  'MMMM d yyyy',
  'MMMM d',
  'd MMM yyyy',
  'd MMM',
  'd MMMM yyyy',
]

/**
 * A day as people type it, as YYYY-MM-DD: "2026-11-04", "11/4/2026", "Nov 4",
 * "4 November 2026", "today", "tomorrow", "yesterday". Null when it is not one.
 */
export function parseDayInput(input: string, now: Date = new Date()): string | null {
  const text = input.trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ')
  if (!text) return null
  const relative = { today: 0, tomorrow: 1, yesterday: -1 }[text]
  if (relative !== undefined) return dayKey(addDays(now, relative))
  for (const pattern of DAY_FORMATS) {
    const date = parse(text, pattern, now)
    if (isValid(date) && date.getFullYear() >= 1000) return dayKey(date)
  }
  return null
}
