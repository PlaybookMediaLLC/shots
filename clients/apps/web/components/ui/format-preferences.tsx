'use client'

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { localeUses12Hour, type TimeFormat } from '@/lib/time-of-day'

/** How a person reads times and weeks; pickers use it without importing app state. */
type FormatPreferences = {
  timeFormat: TimeFormat
  /** 0 is Sunday, 1 Monday; unset follows the locale. */
  weekStartsOn?: 0 | 1
}

const FormatPreferencesContext = createContext<FormatPreferences>({ timeFormat: 'auto' })

/** Hands the signed-in person's time format and week start to every picker below it. */
export function FormatPreferencesProvider({
  children,
  timeFormat,
  weekStartsOn,
}: FormatPreferences & { children: ReactNode }) {
  const value = useMemo(() => ({ timeFormat, weekStartsOn }), [timeFormat, weekStartsOn])
  return <FormatPreferencesContext value={value}>{children}</FormatPreferencesContext>
}

const subscribeNever = () => () => {}

/**
 * Whether times read on a 12-hour clock. `auto` follows the browser locale,
 * which the server cannot know, so it renders 24-hour until hydration.
 */
export function useTwelveHour(): boolean {
  const { timeFormat } = useContext(FormatPreferencesContext)
  const locale = useSyncExternalStore(subscribeNever, localeUses12Hour, () => false)
  return timeFormat === 'auto' ? locale : timeFormat === '12h'
}

/** The first day of a calendar week, or undefined for the locale's. */
export function useWeekStartsOn(): 0 | 1 | undefined {
  return useContext(FormatPreferencesContext).weekStartsOn
}
