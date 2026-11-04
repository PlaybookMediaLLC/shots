'use client'

import { usePreferences } from './PreferencesProvider'
import { SaveStatus, useSaveState } from './controls'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** Save a personal accent; artwork and teammates keep their own colors. */
export function AccentColorSettings() {
  const { preferences, save, status } = usePreferences()
  const [state, run] = useSaveState()
  const disabled = status !== 'ready' || state === 'saving'
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
        <Input
          key={preferences?.accentColor}
          id="personal-accent"
          name="accentColor"
          type="color"
          defaultValue={preferences?.accentColor || '#527bc4'}
          disabled={disabled}
          className="h-9 w-14 rounded border bg-background p-1"
        />
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
