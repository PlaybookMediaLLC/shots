/** A clock, or `auto` for the browser locale's. */
export type TimeFormat = 'auto' | '12h' | '24h'

/**
 * A time of day as people type it, as `HH:mm`: "9", "9a", "9:30 pm", "930p",
 * "0930", "21:30", "2130", "9.30", "noon", "midnight". Null when it is not one.
 */
export function parseTimeOfDay(input: string): string | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ')
  if (text === 'noon') return '12:00'
  if (text === 'midnight') return '00:00'
  const match = /^(\d{1,2})(?:[:.]?(\d{2}))?\s*(am|pm|a|p|a\.m\.|p\.m\.)?$/.exec(text)
  if (!match) return null
  let hours = Number(match[1])
  const minutes = Number(match[2] ?? 0)
  const half = match[3]?.[0]
  if (minutes > 59 || hours > 23 || (half && (hours < 1 || hours > 12))) return null
  if (half === 'p' && hours < 12) hours += 12
  if (half === 'a' && hours === 12) hours = 0
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** Whether this browser's locale reads a 12-hour clock. */
export function localeUses12Hour(): boolean {
  const cycle = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle
  return cycle === 'h11' || cycle === 'h12'
}

/** `HH:mm` as people read it: "9:30 PM" on a 12-hour clock, "21:30" on a 24-hour one. */
export function formatTimeOfDay(time: string, twelveHour: boolean): string {
  const [hours = 0, minutes = 0] = time.split(':').map(Number)
  const mm = String(minutes).padStart(2, '0')
  if (!twelveHour) return `${String(hours).padStart(2, '0')}:${mm}`
  return `${hours % 12 || 12}:${mm} ${hours < 12 ? 'AM' : 'PM'}`
}

/** Every quarter hour of a day, as `HH:mm`. */
export const QUARTER_HOURS: readonly string[] = Array.from(
  { length: 96 },
  (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`
)
