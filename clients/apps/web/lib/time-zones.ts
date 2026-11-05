import { offsetLabel } from '@/lib/write/zoned-time'

/**
 * The zones most people pick, listed first so they win ties: "EST" matches
 * every zone on Eastern Standard Time, and New York should lead them.
 */
const COMMON_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Africa/Lagos',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
]

/** Every IANA zone this runtime knows: UTC, then the common ones, then the rest. */
export function allTimeZones(): string[] {
  const zones =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  const first = ['UTC', ...COMMON_ZONES.filter((zone) => zones.includes(zone))]
  return [...first, ...zones.filter((zone) => !first.includes(zone))]
}

/** The browser's own zone. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** The place a zone is named for: `America/Argentina/Buenos_Aires` is `Buenos Aires`. */
export function zoneCity(zone: string): string {
  return zone.split('/').at(-1)?.replaceAll('_', ' ') ?? zone
}

/** A zone as people read it, never its raw IANA name: `New York · UTC−05:00`. */
export function zoneLabel(zone: string, at: Date = new Date()): string {
  const city = zoneCity(zone)
  return city === 'UTC' ? 'UTC' : `${city} · ${offsetLabel(at, zone)}`
}

const NAME_STYLES = ['short', 'shortGeneric', 'longGeneric'] as const

/**
 * The names a zone goes by in English, in winter and summer: `EST`, `EDT`,
 * `Eastern Time`, `France Time`. They make abbreviation and country searches work.
 */
function zoneNames(zone: string, year: number): string[] {
  const names = new Set<string>()
  for (const month of [0, 6])
    for (const timeZoneName of NAME_STYLES) {
      const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName })
        .formatToParts(Date.UTC(year, month, 15))
        .find((part) => part.type === 'timeZoneName')?.value
      if (name && !name.startsWith('GMT')) names.add(name)
    }
  return [...names]
}

/** A time zone as a Combobox option: readable label, IANA name below, every name it goes by. */
export type ZoneOption = {
  description: string
  keywords: string[]
  label: string
  value: string
}

let cached: { day: string; options: ZoneOption[] } | null = null

/**
 * Options for a time-zone picker, searchable by city, region, country or
 * abbreviation. Building them costs a few hundred Intl formatters, so the
 * full list is built once a day per page.
 */
export function zoneOptions(zones?: readonly string[], at = new Date()): ZoneOption[] {
  const day = at.toISOString().slice(0, 10)
  if (!zones && cached?.day === day) return cached.options
  const options = (zones ?? allTimeZones()).map((zone) => ({
    description: zone,
    keywords: [...zone.replaceAll('_', ' ').split('/'), offsetLabel(at, zone), ...zoneNames(zone, at.getUTCFullYear())],
    label: zoneLabel(zone, at),
    value: zone,
  }))
  if (!zones) cached = { day, options }
  return options
}
