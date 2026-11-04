'use client'

import { useState } from 'react'
import { usePreferences } from './PreferencesProvider'
import { SaveStatus, useSaveState } from './controls'
import { Button } from '@/components/ui/button'
import { SwatchColorPicker } from '@/components/ui/color-picker'
import { Label } from '@/components/ui/label'

/** Save a personal accent; artwork and teammates keep their own colors. */
export function AccentColorSettings() {
  const { preferences, save, status } = usePreferences()
  const [state, run] = useSaveState()
  const disabled = status !== 'ready' || state === 'saving'
  const [draft, setDraft] = useState<string | null>(null)
  const accent = draft ?? (preferences?.accentColor || '#527bc4')
  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const accentColor = String(new FormData(event.currentTarget).get('accentColor'))
        void run(() => save({ accentColor }))
      }}
    >
      <Label className="text-ui-lg font-medium" htmlFor="personal-accent">
        Accent color
      </Label>
      <p className="text-xs text-muted-foreground">
        Choose a brand color for workspace buttons and focus rings. Text contrast adjusts
        automatically.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <SwatchColorPicker
          disabled={disabled}
          id="personal-accent"
          onChange={setDraft}
          value={accent}
        />
        <input name="accentColor" type="hidden" value={accent} />
        <Button size="sm" disabled={disabled} type="submit">
          Apply accent
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || !preferences?.accentColor}
          type="button"
          onClick={() => void run(() => save({ accentColor: '' }))}
        >
          Reset accent
        </Button>
        <SaveStatus state={state} />
      </div>
    </form>
  )
}
