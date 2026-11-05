'use client'

import * as React from 'react'
import { useTwelveHour } from '@/components/ui/format-preferences'

function noSubscription(): () => void {
  return () => {}
}

/** False during the server render and hydration, true in the browser after. */
export function useHydrated(): boolean {
  return React.useSyncExternalStore(
    noSubscription,
    () => true,
    () => false
  )
}

/** The app's one way to write a moment: "Nov 3, 2026, 11:40 PM EST". */
export const WHEN_STYLE: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  month: 'short',
  timeZoneName: 'short',
  year: 'numeric',
}

/** A day alone, in the same style: "Nov 3, 2026". */
export const DAY_STYLE: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
}

/**
 * Writes a moment in the app's style, in a zone (a brand's, or the reader's
 * when none), on the 12- or 24-hour clock the person chose. Call it after
 * hydration, as {@link LocalTime} does: the server knows neither zone nor locale.
 */
export function useWhen(): (
  value: Date | string,
  zone?: string | null,
  style?: Intl.DateTimeFormatOptions
) => string {
  const twelveHour = useTwelveHour()
  return React.useCallback(
    (value, zone, style = WHEN_STYLE) =>
      new Date(value).toLocaleString(undefined, {
        ...style,
        hour12: twelveHour,
        ...(zone ? { timeZone: zone } : {}),
      }),
    [twelveHour]
  )
}

/**
 * A moment in a brand's zone, or the reader's own when none is given. The
 * server knows neither zone nor locale, so it renders an empty element and
 * the browser fills it in: rendering the server's zone instead would mismatch
 * on hydration and show the wrong time.
 */
export function LocalTime({
  options,
  value,
  zone,
}: {
  options?: Intl.DateTimeFormatOptions
  value: Date | string
  zone?: string | null
}) {
  const hydrated = useHydrated()
  const when = useWhen()
  const date = new Date(value)
  return <time dateTime={date.toISOString()}>{hydrated ? when(date, zone, options) : null}</time>
}
