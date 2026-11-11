'use client'

import { CheckIcon } from '@phosphor-icons/react/dist/ssr/Check'
import { ClockIcon } from '@phosphor-icons/react/dist/ssr/Clock'
import { Command } from 'cmdk'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { commandItemClassName } from '@/components/ui/combobox'
import { useTwelveHour } from '@/components/ui/format-preferences'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { QUARTER_HOURS, formatTimeOfDay, parseTimeOfDay } from '@/lib/time-of-day'
import { cn } from '@/lib/utils'

/**
 * A time of day, stored as `HH:mm`. Type "9", "9a", "930p" or "21:30" and it
 * reads back as "9:30 PM" (or "21:30" on a 24-hour clock); the clock button
 * lists quarter hours, opened at the current value or 9:00 AM.
 */
export function TimePicker({
  className,
  disabled,
  id,
  name,
  onChange,
  onValidityChange,
  placeholder,
  required,
  value,
  'aria-describedby': describedBy,
  'aria-label': ariaLabel,
}: {
  className?: string
  disabled?: boolean
  id?: string
  /** Submits the `HH:mm` value with a form under this name. */
  name?: string
  /** Receives `HH:mm`, or `''` when an optional time is cleared. */
  onChange: (value: string) => void
  /** Lets actions outside a native form reject an invalid visible draft. */
  onValidityChange?: (valid: boolean) => void
  placeholder?: string
  required?: boolean
  value: string
  'aria-describedby'?: string
  'aria-label'?: string
}) {
  const twelveHour = useTwelveHour()
  const [draft, setDraft] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)
  const [observed, setObserved] = useState(value)
  const [emitted, setEmitted] = useState<string | null>(null)
  if (value !== observed) {
    setObserved(value)
    if (value !== emitted) {
      setDraft(null)
      setTouched(false)
    }
    setEmitted(null)
  }
  const publish = (next: string) => {
    setEmitted(next)
    onChange(next)
  }
  const [open, setOpen] = useState(false)
  const errorId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const shown = draft ?? (value ? formatTimeOfDay(value, twelveHour) : '')
  const valid = !shown.trim() ? !required : parseTimeOfDay(shown) !== null
  const invalid = !valid && touched
  const message = `Enter a time such as ${twelveHour ? '9:30 AM' : '09:30'}.`
  useEffect(() => {
    inputRef.current?.setCustomValidity(valid ? '' : message)
    onValidityChange?.(valid)
  }, [message, onValidityChange, valid])
  const times =
    value && !QUARTER_HOURS.includes(value) ? [...QUARTER_HOURS, value].sort() : QUARTER_HOURS

  const settle = () => {
    setDraft(null)
    setTouched(false)
  }
  // A readable time applies as it is typed; leaving the field shows it normalized.
  const type = (text: string) => {
    setDraft(text)
    setTouched(false)
    const time = parseTimeOfDay(text)
    if (time && time !== value) publish(time)
    else if (!text.trim() && !required) publish('')
  }
  const commit = () => {
    if (draft === null) return
    if (!draft.trim()) {
      if (required) return setTouched(true)
      publish('')
      settle()
      return
    }
    // Keep what was typed so it can be fixed; the value stays the last valid one.
    if (!parseTimeOfDay(draft)) return setTouched(true)
    settle()
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverAnchor asChild>
        <div className={cn('relative w-36 min-w-0', className)}>
          <Input
            aria-describedby={
              [describedBy, invalid ? errorId : undefined].filter(Boolean).join(' ') || undefined
            }
            aria-invalid={invalid || undefined}
            aria-label={ariaLabel}
            autoComplete="off"
            className="pr-9"
            disabled={disabled}
            id={id}
            onBlur={commit}
            onInvalid={() => setTouched(true)}
            onChange={(event) => type(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commit()
              } else if (event.key === 'Escape' && draft !== null) {
                event.preventDefault()
                settle()
              } else if (event.key === 'ArrowDown') {
                event.preventDefault()
                setOpen(true)
              }
            }}
            placeholder={placeholder ?? 'Type a time'}
            required={required}
            ref={inputRef}
            value={shown}
          />
          <PopoverTrigger asChild>
            <Button
              aria-label={ariaLabel ? `Choose ${ariaLabel.toLowerCase()}` : 'Choose a time'}
              className="absolute top-1/2 right-0.5 -translate-y-1/2 text-muted-foreground"
              disabled={disabled}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <ClockIcon />
            </Button>
          </PopoverTrigger>
          {name ? (
            <input disabled={!valid || disabled} name={name} type="hidden" value={value} />
          ) : null}
        </div>
      </PopoverAnchor>
      {invalid ? (
        <p className="mt-1 text-xs text-destructive" id={errorId} role="alert">
          {message}
        </p>
      ) : null}
      <PopoverContent
        align="start"
        className="w-40 p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          // Open at the current value, or a working-hours default, never midnight.
          requestAnimationFrame(() => {
            listRef.current?.focus()
            listRef.current
              ?.querySelector('[data-selected="true"]')
              ?.scrollIntoView({ block: 'center' })
          })
        }}
      >
        <Command
          className="outline-hidden"
          defaultValue={value || '09:00'}
          label={ariaLabel ?? 'Time'}
          loop
          ref={listRef}
          tabIndex={-1}
        >
          <Command.List className="max-h-80 overflow-y-auto p-1">
            {times.map((time) => (
              <Command.Item
                className={commandItemClassName}
                key={time}
                onSelect={() => {
                  settle()
                  publish(time)
                  setOpen(false)
                }}
                value={time}
              >
                {formatTimeOfDay(time, twelveHour)}
                {time === value ? (
                  <CheckIcon aria-hidden className="absolute right-2 size-4" />
                ) : null}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
