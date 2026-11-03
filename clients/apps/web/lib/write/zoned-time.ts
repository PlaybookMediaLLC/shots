import { z } from 'zod'
import { parseWhen } from '@/lib/content-drafts/when'

/**
 * Local wall times in an IANA time zone (RFC 025). A schedule is chosen as a
 * date and time in the social set's zone; this resolves it to the instant it
 * names, and says when it names none (the clocks skip it) or two (the clocks
 * repeat it). The backend resolves the same way (`resolveLocalTime` in Go)
 * and is the authority; this lets the picker explain before submitting.
 */

/** A local date and time to the minute, as `YYYY-MM-DDTHH:mm`. */
export const localDateTimeSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)

/** Which instant to take when a local time happens twice. */
export const disambiguationSchema = z.enum(['earlier', 'later', 'reject'])

/** One of {@link disambiguationSchema}. */
export type Disambiguation = z.infer<typeof disambiguationSchema>

/** What a local time names in a zone. */
export type ZonedResolution =
  { at: Date; kind: 'exact' } | { earlier: Date; kind: 'ambiguous'; later: Date } | { kind: 'gap' }

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone)
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      minute: '2-digit',
      month: '2-digit',
      timeZone: zone,
      year: 'numeric',
    })
    formatters.set(zone, found)
  }
  return found
}

/** Whether `zone` is an IANA zone this runtime knows. */
export function isTimeZone(zone: string): boolean {
  try {
    formatter(zone)
    return true
  } catch {
    return false
  }
}

/** The wall time an instant shows in a zone, as `YYYY-MM-DDTHH:mm`. */
export function wallTime(at: Date, zone: string): string {
  const parts = Object.fromEntries(
    formatter(zone)
      .formatToParts(at)
      .map((part) => [part.type, part.value])
  )
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

/** The zone's offset from UTC at an instant, in minutes. */
export function offsetMinutes(at: Date, zone: string): number {
  const wall = wallTime(at, zone)
  const asUtc = Date.parse(`${wall}:00Z`)
  const instant = Math.floor(at.getTime() / 60_000) * 60_000
  return Math.round((asUtc - instant) / 60_000)
}

/**
 * Resolve a local time in a zone. Offsets around the time are tried; each
 * that maps back to the same wall time is an instant it names.
 */
export function resolveLocalTime(local: string, zone: string): ZonedResolution {
  const naive = Date.parse(`${localDateTimeSchema.parse(local)}:00Z`)
  const offsets = new Set(
    [-36, -24, -12, 0, 12, 24, 36].map((hours) =>
      offsetMinutes(new Date(naive + hours * 3_600_000), zone)
    )
  )
  const instants = [...offsets]
    .map((offset) => naive - offset * 60_000)
    .filter((instant) => wallTime(new Date(instant), zone) === local)
    .sort((a, b) => a - b)
  const unique = [...new Set(instants)]
  if (unique.length === 0) return { kind: 'gap' }
  if (unique.length === 1) return { at: new Date(unique[0]), kind: 'exact' }
  return {
    earlier: new Date(unique[0]),
    kind: 'ambiguous',
    later: new Date(unique[unique.length - 1]),
  }
}

/** `UTC+05:30`, `UTC−04:00`: the zone's offset at an instant, for display. */
export function offsetLabel(at: Date, zone: string): string {
  const offset = offsetMinutes(at, zone)
  const sign = offset < 0 ? '−' : '+'
  const absolute = Math.abs(offset)
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0')
  const minutes = String(absolute % 60).padStart(2, '0')
  return `UTC${sign}${hours}:${minutes}`
}

/**
 * What a confirmed schedule committed, as stored: when the first post
 * publishes in the brand's zone with its UTC offset, and the queue slot it
 * holds when a natural offset moves it off the slot.
 */
export function committedMessage(
  posts: { scheduledFor: string; slotAt?: string | null }[],
  zone: string,
  queue: boolean
): string {
  const count = `${posts.length} post${posts.length === 1 ? '' : 's'}`
  const done = queue ? `Added ${count} to the queue` : `Scheduled ${count}`
  const first = posts[0]
  if (!first) return `${done}.`
  const at = new Date(first.scheduledFor)
  const slot =
    first.slotAt && Date.parse(first.slotAt) !== at.getTime() ? new Date(first.slotAt) : null
  const when = (value: Date, timeStyle: 'short' | 'medium') =>
    value.toLocaleString(undefined, { dateStyle: 'medium', timeStyle, timeZone: zone })
  const zoned = `${zone} (${offsetLabel(at, zone)})`
  return slot
    ? `${done} in the ${when(slot, 'short')} slot, publishing ${when(at, 'medium')} · ${zoned}.`
    : `${done} for ${when(at, 'short')} · ${zoned}.`
}

/**
 * A typed time ("tomorrow 9am", "in 3 hours") read in `zone`, as a wall
 * time rounded up to the quarter hour, or null. The parser works in the
 * runtime's own clock, so it is handed the zone's wall time as "now".
 */
export function readWhen(text: string, zone: string, now: Date = new Date()): string | null {
  const parsed = parseWhen(text, new Date(`${wallTime(now, zone)}:00`))
  if (!parsed) return null
  const quarter = Math.ceil(parsed.getMinutes() / 15) * 15
  return new Date(
    Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), parsed.getHours(), quarter)
  )
    .toISOString()
    .slice(0, 16)
}
