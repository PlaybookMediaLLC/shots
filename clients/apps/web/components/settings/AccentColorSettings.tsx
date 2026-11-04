'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { usePreferences } from './PreferencesProvider'
import { SaveStatus, useSaveState } from './controls'
import { Button } from '@/components/ui/button'
import { SwatchColorPicker } from '@/components/ui/color-picker'
import { Label } from '@/components/ui/label'

/** The accent the picker shows when none is saved. */
const STANDARD_ACCENT = '#527bc4'

/**
 * A personal accent; artwork and teammates keep their own colors. It saves
 * when the picker closes, like the page's other settings; Reset can be undone.
 */
export function AccentColorSettings() {
  const { preferences, save, status } = usePreferences()
  const [state, run] = useSaveState()
  const disabled = status !== 'ready' || state === 'saving'
  const saved = preferences?.accentColor ?? ''
  const [draft, setDraft] = useState<string | null>(null)
  const accent = draft ?? (saved || STANDARD_ACCENT)
  return (
    <div className="grid gap-2">
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
          onOpenChange={(open) => {
            if (open || draft === null) return
            const accentColor = draft
            setDraft(null)
            if (accentColor !== saved) void run(() => save({ accentColor }))
          }}
          value={accent}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || !saved}
          type="button"
          onClick={() =>
            void run(() => save({ accentColor: '' })).then((reset) => {
              if (reset)
                toast('Accent reset to the standard palette.', {
                  action: { label: 'Undo', onClick: () => void run(() => save({ accentColor: saved })) },
                  duration: 5000,
                })
            })
          }
        >
          Reset accent
        </Button>
        <SaveStatus state={state} />
      </div>
    </div>
  )
}
