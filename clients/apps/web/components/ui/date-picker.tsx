'use client'

import { CalendarIcon as CalendarIcon } from '@phosphor-icons/react/dist/ssr/Calendar'
import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { dayDate, dayKey, parseDayInput } from '@/lib/calendar-day'
import { cn } from '@/lib/utils'

/** Whether a YYYY-MM-DD day is inside optional YYYY-MM-DD bounds. */
function inBounds(day: string, min?: string, max?: string): boolean {
  return (!min || day >= min) && (!max || day <= max)
}

/**
 * A day picked from a {@link Calendar} in a popover, or typed ("Nov 4",
 * "11/4/2026", "tomorrow") in the field above it. The value is a calendar
 * day, YYYY-MM-DD, as a native date input's would be; `min` and `max` bound
 * it the same way, and weeks start on the person's chosen day.
 */
function DatePicker({
  className,
  disabled,
  id,
  max,
  min,
  onChange,
  placeholder = 'Pick a day',
  value,
  ...props
}: {
  className?: string
  disabled?: boolean
  id?: string
  max?: string
  min?: string
  onChange: (day: string) => void
  placeholder?: string
  value: string
} & Pick<React.ComponentProps<'button'>, 'aria-label' | 'aria-describedby'>) {
  const [open, setOpen] = React.useState(false)
  const [typed, setTyped] = React.useState('')
  const [typedError, setTypedError] = React.useState('')
  const errorId = React.useId()
  const selected = dayDate(value)
  const from = min ? dayDate(min) : undefined
  const to = max ? dayDate(max) : undefined
  const today = dayKey(new Date())
  const choose = (day: string) => {
    onChange(day)
    setOpen(false)
  }
  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next)
        setTyped('')
        setTypedError('')
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <Button
          className={cn(
            'h-9 justify-start gap-2 font-normal',
            !selected && 'text-muted-foreground',
            className
          )}
          disabled={disabled}
          id={id}
          type="button"
          variant="outline"
          {...props}
        >
          <CalendarIcon aria-hidden className="size-4" />
          {selected
            ? selected.toLocaleDateString(undefined, { dateStyle: 'medium' })
            : placeholder}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <form
          className="grid gap-1 border-b p-3"
          onSubmit={(event) => {
            event.preventDefault()
            // Portaled, but React still bubbles a submit to a form the picker sits in.
            event.stopPropagation()
            const day = parseDayInput(typed)
            if (!day) return setTypedError('Enter a day such as Nov 4 or 11/4/2026.')
            if (!inBounds(day, min, max)) return setTypedError('That day is outside the range here.')
            choose(day)
          }}
        >
          <Input
            aria-describedby={typedError ? errorId : undefined}
            aria-invalid={typedError ? true : undefined}
            aria-label="Type a day"
            className="h-8"
            onChange={(event) => {
              setTyped(event.target.value)
              setTypedError('')
            }}
            placeholder="Type a day, then Enter"
            value={typed}
          />
          {typedError ? (
            <p className="text-xs text-destructive" id={errorId} role="alert">
              {typedError}
            </p>
          ) : null}
        </form>
        <Calendar
          autoFocus
          defaultMonth={selected ?? from}
          disabled={[...(from ? [{ before: from }] : []), ...(to ? [{ after: to }] : [])]}
          mode="single"
          onSelect={(date) => {
            if (date) choose(dayKey(date))
          }}
          selected={selected}
        />
        <div className="flex justify-end border-t p-2">
          <Button
            disabled={!inBounds(today, min, max)}
            onClick={() => choose(today)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Today
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export { DatePicker }
