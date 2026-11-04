'use client'

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import type { SaveResult } from '@/components/settings/PreferencesProvider'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { cn } from '@/lib/utils'

/** Where a save is: nothing yet, under way, confirmed by the server, or refused. */
export const saveStateSchema = z.enum(['idle', 'saving', 'saved', 'error'])

/** One of {@link saveStateSchema}. */
export type SaveState = z.infer<typeof saveStateSchema>

/**
 * Runs a save and reports its state. "Saved" appears only after the server
 * confirms; a refusal shows the reason, and the caller has already restored
 * the previous value.
 */
export function useSaveState(): [SaveState, (run: () => Promise<SaveResult>) => Promise<boolean>] {
  const [state, setState] = useState<SaveState>('idle')
  const run = useCallback(async (save: () => Promise<SaveResult>) => {
    setState('saving')
    const result = await save()
    if (result.ok) {
      setState('saved')
      return true
    }
    setState('error')
    toast.error(result.error)
    return false
  }, [])
  return [state, run]
}

/** A polite announcement of a save's state, beside the control it belongs to. */
export function SaveStatus({ state }: { state: SaveState }) {
  const text = { error: 'Not saved', idle: '', saved: 'Saved', saving: 'Saving…' }[state]
  return (
    <span
      aria-live="polite"
      className={cn('min-w-16 text-xs', state === 'error' ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground')}
      role="status"
    >
      {text}
    </span>
  )
}

/** One choice of a {@link ChoiceGroup}. */
export type Choice<Value extends string> = { description?: string; label: string; value: Value }

/**
 * A labelled set of radio choices. Arrow keys move between them, as for any
 * radio group, and the legend names the setting for screen readers.
 */
export function ChoiceGroup<Value extends string>({
  choices,
  disabled,
  legend,
  name,
  onChange,
  status,
  value,
}: {
  choices: Choice<Value>[]
  disabled?: boolean
  legend: string
  name: string
  onChange: (value: Value) => void
  status?: SaveState
  value: Value | undefined
}) {
  return (
    <fieldset className="grid gap-2" disabled={disabled}>
      <div className="flex items-center justify-between gap-3">
        <legend className="text-ui-lg font-medium text-foreground">{legend}</legend>
        {status ? <SaveStatus state={status} /> : null}
      </div>
      <RadioGroup
        aria-label={legend}
        className="sm:grid-cols-3"
        disabled={disabled}
        name={name}
        onValueChange={(next) => {
          const choice = choices.find((item) => item.value === next)
          if (choice) onChange(choice.value)
        }}
        value={value ?? ''}
      >
        {choices.map((choice) => (
          <Label
            className={cn(
              'flex cursor-pointer flex-col items-stretch gap-0.5 rounded-xl border px-3 py-2.5 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
              value === choice.value
                ? 'border-foreground/40 bg-foreground/[0.05] text-foreground'
                : 'border-border text-foreground/80 hover:bg-foreground/[0.03]'
            )}
            key={choice.value}
          >
            <span className="flex items-center gap-2 font-medium">
              <RadioGroupItem value={choice.value} />
              {choice.label}
            </span>
            {choice.description ? <span className="text-xs text-muted-foreground">{choice.description}</span> : null}
          </Label>
        ))}
      </RadioGroup>
    </fieldset>
  )
}
