'use client'

import { AccentColorSettings } from './AccentColorSettings'
import { ChoiceGroup, useSaveState } from '@/components/settings/controls'
import { type Preferences, usePreferences } from '@/components/settings/PreferencesProvider'

/**
 * Appearance (RFC 024): how Shots looks to you, on every device you sign in
 * on. Each choice applies at once and is kept only when the server confirms
 * it; if a save fails, the previous choice comes back.
 */
export function AppearanceSettings() {
  const { preferences, save, status } = usePreferences()
  const [themeState, runTheme] = useSaveState()
  const [navigationState, runNavigation] = useSaveState()
  const [weekState, runWeek] = useSaveState()
  const [timeFormatState, runTimeFormat] = useSaveState()
  const [directionState, runDirection] = useSaveState()
  const disabled = status !== 'ready'

  if (status === 'error') {
    return (
      <p className="text-sm text-red-700 dark:text-red-300" role="alert">
        Your appearance settings could not be loaded. Reload the page to try again.
      </p>
    )
  }

  return (
    <div className="grid gap-6" aria-busy={status === 'loading'}>
      <ChoiceGroup<Preferences['theme']>
        choices={[
          { description: 'Dark text on light surfaces.', label: 'Light', value: 'light' },
          { description: 'Light text on dark surfaces.', label: 'Dark', value: 'dark' },
          {
            description: "Follows your computer's setting as it changes.",
            label: 'System',
            value: 'system',
          },
        ]}
        disabled={disabled}
        legend="Theme"
        name="theme"
        onChange={(theme) => void runTheme(() => save({ theme }))}
        status={themeState}
        value={preferences?.theme}
      />
      <p className="-mt-3 text-xs text-muted-foreground">
        Your theme follows you throughout the workspace. Artwork and exported images keep their own
        colors.
      </p>
      <AccentColorSettings />
      <ChoiceGroup<Preferences['navigation']>
        choices={[
          {
            description: 'Icons only; labels appear on hover.',
            label: 'Always compact',
            value: 'compact',
          },
          {
            description:
              'Labels on wide screens, icons on narrow ones, with a button to open it for a moment.',
            label: 'Dynamic',
            value: 'dynamic',
          },
          {
            description: 'Icons and labels everywhere.',
            label: 'Always expanded',
            value: 'expanded',
          },
        ]}
        disabled={disabled}
        legend="Desktop navigation"
        name="navigation"
        onChange={(navigation) => void runNavigation(() => save({ navigation }))}
        status={navigationState}
        value={preferences?.navigation}
      />
      <ChoiceGroup<Preferences['weekStart']>
        choices={[
          { label: 'Monday', value: 'monday' },
          { label: 'Sunday', value: 'sunday' },
        ]}
        disabled={disabled}
        legend="Calendar starts on"
        name="week-start"
        onChange={(weekStart) => void runWeek(() => save({ weekStart }))}
        status={weekState}
        value={preferences?.weekStart}
      />
      <ChoiceGroup<Preferences['timeFormat']>
        choices={[
          { description: "Follows this device's language settings.", label: 'Automatic', value: 'auto' },
          { description: 'Such as 9:30 PM.', label: '12-hour', value: '12h' },
          { description: 'Such as 21:30.', label: '24-hour', value: '24h' },
        ]}
        disabled={disabled}
        legend="Time format"
        name="time-format"
        onChange={(timeFormat) => void runTimeFormat(() => save({ timeFormat }))}
        status={timeFormatState}
        value={preferences?.timeFormat}
      />
      <ChoiceGroup<Preferences['textDirection']>
        choices={[
          {
            description: 'For English, French, Japanese and most languages.',
            label: 'Left to right',
            value: 'ltr',
          },
          {
            description: 'For Arabic, Hebrew, Persian and Urdu.',
            label: 'Right to left',
            value: 'rtl',
          },
        ]}
        disabled={disabled}
        legend="Editor text direction"
        name="text-direction"
        onChange={(textDirection) => void runDirection(() => save({ textDirection }))}
        status={directionState}
        value={preferences?.textDirection}
      />
    </div>
  )
}
