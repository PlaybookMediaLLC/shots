'use client'

import { useId, useSyncExternalStore } from 'react'
import { Combobox, type ComboboxOption } from '@/components/ui/combobox'
import { Label } from '@/components/ui/label'
import { browserTimeZone, zoneCity, zoneLabel, zoneOptions } from '@/lib/time-zones'
import { cn } from '@/lib/utils'

const subscribeNever = () => () => {}

/** Combobox stand-ins for the two rows that are not a zone of their own. */
const FOLLOW_BROWSER = '__browser__'
const USE_MINE = '__mine__'

/**
 * True in the browser after hydration. Offsets and the browser's zone differ
 * between server and browser, so they render only then.
 */
function useInBrowser(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false
  )
}

/**
 * Picks an IANA time zone. Search by city, region, country or abbreviation
 * ("Paris", "EST"); rows read "New York · UTC−05:00" with the IANA name below.
 * "Use my time zone" picks the browser's zone. The value stays the IANA name.
 */
export function TimeZonePicker({
  allowBrowser,
  className,
  disabled,
  hideLabel,
  label,
  onChange,
  size,
  value,
}: {
  /** Offer "follow my browser", saved as no zone. */
  allowBrowser?: boolean
  className?: string
  disabled?: boolean
  /** The row around it already shows the label; keep it for screen readers only. */
  hideLabel?: boolean
  label: string
  onChange: (zone: string) => void
  size?: 'default' | 'sm'
  value: string | null
}) {
  const id = useId()
  const inBrowser = useInBrowser()
  const browser = inBrowser ? browserTimeZone() : null
  const options = (): ComboboxOption[] => [
    ...(allowBrowser
      ? [
          {
            description: browser ?? undefined,
            label: browser ? `Follow my browser (${zoneLabel(browser)})` : 'Follow my browser',
            value: FOLLOW_BROWSER,
          },
        ]
      : [
          {
            description: browser ? zoneLabel(browser) : undefined,
            keywords: ['detect', 'local', 'browser'],
            label: 'Use my time zone',
            value: USE_MINE,
          },
        ]),
    ...zoneOptions(),
  ]
  const shown = value
    ? inBrowser
      ? zoneLabel(value)
      : zoneCity(value)
    : allowBrowser
      ? browser
        ? `Follow my browser (${zoneLabel(browser)})`
        : 'Follow my browser'
      : undefined

  return (
    <div className={cn('grid w-full min-w-0 gap-1 text-sm', className)}>
      <Label className={cn('font-medium text-foreground', hideLabel && 'sr-only')} htmlFor={id}>
        {label}
      </Label>
      <Combobox
        className="w-full bg-card text-foreground"
        disabled={disabled}
        id={id}
        onValueChange={(zone) => {
          if (zone === FOLLOW_BROWSER) onChange('')
          else onChange(zone === USE_MINE ? browserTimeZone() : zone)
        }}
        options={options}
        placeholder="Choose a time zone"
        searchPlaceholder="City, country or abbreviation"
        size={size}
        value={value ?? (allowBrowser ? FOLLOW_BROWSER : null)}
        valueLabel={shown}
      />
    </div>
  )
}
