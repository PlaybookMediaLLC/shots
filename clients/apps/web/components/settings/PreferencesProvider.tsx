'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTheme } from 'next-themes'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useState,
} from 'react'
import type { z } from 'zod'
import { FormatPreferencesProvider } from '@/components/ui/format-preferences'
import {
  userPreferencesSchema,
  type userPreferencesUpdateSchema,
} from '@/lib/api/contracts/settings-platform'
import { installDebugErrorHandlers } from '@/lib/debug-log'
import { accentForeground } from '@/lib/settings/accent'
import { NAVIGATION_COOKIE } from '@/lib/settings/appearance'
import { settingsErrorMessage, settingsRequest } from '@/lib/settings/client'

/** A person's preferences as the API returns them. */
export type Preferences = z.output<typeof userPreferencesSchema>

/** A preferences save. */
export type PreferencesUpdate = z.input<typeof userPreferencesUpdateSchema>

/** The outcome of a save: persisted, or refused with the reason. */
export type SaveResult = { error: string; ok: false } | { ok: true }

const PREFERENCES_KEY = ['me', 'preferences'] as const

type PreferencesState = {
  preferences: Preferences | null
  /** Saves a change; the UI shows it at once and takes it back if the save fails. */
  save: (update: PreferencesUpdate) => Promise<SaveResult>
  status: 'error' | 'loading' | 'ready'
}

const PreferencesContext = createContext<PreferencesState>({
  preferences: null,
  save: async () => ({ error: 'Preferences are not available here.', ok: false }),
  status: 'loading',
})

function rememberNavigation(value: Preferences['navigation']) {
  document.cookie = `${NAVIGATION_COOKIE}=${value}; path=/; max-age=31536000; samesite=lax`
}

/**
 * Loads the signed-in person's preferences (RFC 024) and applies the ones
 * that change the page: theme and the navigation cookie. A change
 * shows at once; the server's answer confirms it, and a refusal restores the
 * previous value, so the page never claims a save that did not happen.
 */
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const { setTheme } = useTheme()
  const query = useQuery({
    queryFn: () => settingsRequest('/api/v1/me/preferences', userPreferencesSchema),
    queryKey: PREFERENCES_KEY,
    retry: 1,
    staleTime: 5 * 60 * 1000,
  })
  const [pending, setPending] = useState<Preferences | null>(null)
  const preferences = pending ?? query.data ?? null

  // Another device may have changed the theme: the saved one wins on load.
  // next-themes makes a new setTheme each time the theme changes; depending on
  // it here put the old theme back over an optimistic switch until the save landed.
  const savedTheme = query.data?.theme
  const applySavedTheme = useEffectEvent((theme: Preferences['theme']) => setTheme(theme))
  useEffect(() => {
    if (savedTheme) applySavedTheme(savedTheme)
  }, [savedTheme])

  const accent = preferences?.accentColor
  useEffect(() => {
    if (!accent) return
    const style = document.documentElement.style
    const variables = {
      '--primary': accent,
      '--primary-foreground': accentForeground(accent),
      '--ring': accent,
      '--sidebar-primary': accent,
      '--sidebar-primary-foreground': accentForeground(accent),
    }
    const previous = Object.fromEntries(
      Object.keys(variables).map((name) => [name, style.getPropertyValue(name)])
    )
    for (const [name, value] of Object.entries(variables)) style.setProperty(name, value)
    return () => {
      for (const [name, value] of Object.entries(previous)) {
        if (value) style.setProperty(name, value)
        else style.removeProperty(name)
      }
    }
  }, [accent])

  const savedNavigation = query.data?.navigation
  useEffect(() => {
    if (savedNavigation) rememberNavigation(savedNavigation)
  }, [savedNavigation])

  useEffect(() => installDebugErrorHandlers(), [])

  const save = useCallback(
    async (update: PreferencesUpdate): Promise<SaveResult> => {
      const previous = queryClient.getQueryData<Preferences>(PREFERENCES_KEY)
      if (!previous) return { error: 'Your preferences are still loading.', ok: false }
      const optimistic: Preferences = {
        ...previous,
        ...(update.accentColor === undefined ? {} : { accentColor: update.accentColor }),
        ...(update.theme ? { theme: update.theme } : {}),
        ...(update.navigation ? { navigation: update.navigation } : {}),
        ...(update.weekStart ? { weekStart: update.weekStart } : {}),
        ...(update.timeFormat ? { timeFormat: update.timeFormat } : {}),
        ...(update.textDirection ? { textDirection: update.textDirection } : {}),
        ...(update.showScrollbars === undefined ? {} : { showScrollbars: update.showScrollbars }),
        ...(update.developerMode === undefined ? {} : { developerMode: update.developerMode }),
        ...(update.emailNotifications === undefined
          ? {}
          : { emailNotifications: update.emailNotifications }),
        ...(update.timeZone === undefined ? {} : { timeZone: update.timeZone || null }),
      }
      setPending(optimistic)
      if (update.theme) setTheme(update.theme)
      if (update.navigation) rememberNavigation(update.navigation)
      try {
        const saved = await settingsRequest('/api/v1/me/preferences', userPreferencesSchema, {
          body: update,
          method: 'PATCH',
        })
        queryClient.setQueryData(PREFERENCES_KEY, saved)
        return { ok: true }
      } catch (error) {
        setTheme(previous.theme)
        rememberNavigation(previous.navigation)
        return { error: settingsErrorMessage(error), ok: false }
      } finally {
        setPending(null)
      }
    },
    [queryClient, setTheme]
  )

  return (
    <PreferencesContext
      value={{
        preferences,
        save,
        status: query.isError ? 'error' : preferences ? 'ready' : 'loading',
      }}
    >
      <FormatPreferencesProvider
        timeFormat={preferences?.timeFormat ?? 'auto'}
        weekStartsOn={
          preferences ? (preferences.weekStart === 'sunday' ? 0 : 1) : undefined
        }
      >
        {children}
      </FormatPreferencesProvider>
    </PreferencesContext>
  )
}

/** The signed-in person's preferences and a way to save them. */
export function usePreferences(): PreferencesState {
  return useContext(PreferencesContext)
}

/** Whether development mode shows technical IDs. */
export function useDeveloperMode(): boolean {
  return usePreferences().preferences?.developerMode ?? false
}
