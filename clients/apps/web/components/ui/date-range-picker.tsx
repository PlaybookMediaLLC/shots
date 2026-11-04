'use client'

import { CalendarIcon } from '@phosphor-icons/react/dist/ssr/Calendar'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { dayDate, dayKey } from '@/lib/calendar-day'
import { cn } from '@/lib/utils'

/** An inclusive range of calendar days, YYYY-MM-DD, `from` on or before `to`. */
export type DayRange = { from: string; to: string }

/** A range as people read it: `Oct 5 – Nov 4, 2026`. */
function rangeLabel({ from, to }: DayRange): string {
  const start = dayDate(from)
  const end = dayDate(to)
  if (!start || !end) return 'Pick dates'
  const sameYear = start.getFullYear() === end.getFullYear()
  const first = start.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
  return `${first} – ${end.toLocaleDateString(undefined, { dateStyle: 'medium' })}`
}

/**
 * Picks a range of days: presets on the left, two months on the right. A
 * preset applies at once; on the calendar the second day picked applies the
 * range. There is no Apply button.
 */
export function DateRangePicker({
  className,
  disabled,
  id,
  max,
  min,
  onChange,
  onPreset,
  preset,
  presets = [],
  value,
  'aria-label': ariaLabel,
}: {
  className?: string
  disabled?: boolean
  id?: string
  max?: string
  min?: string
  onChange: (range: DayRange) => void
  /** Called with a preset's label; the caller knows what range it means. */
  onPreset?: (label: string) => void
  /** The preset the value came from, shown on the trigger; anything else is custom. */
  preset?: string
  presets?: readonly string[]
  value: DayRange
  'aria-label'?: string
}) {
  const [open, setOpen] = useState(false)
  // The first day of a range being picked; the second click completes it.
  const [anchor, setAnchor] = useState<string | null>(null)
  const start = dayDate(anchor ?? value.from)
  const end = anchor ? undefined : dayDate(value.to)
  const bounds = [
    ...(min && dayDate(min) ? [{ before: dayDate(min)! }] : []),
    ...(max && dayDate(max) ? [{ after: dayDate(max)! }] : []),
  ]
  const shownPreset = preset && presets.includes(preset) ? preset : null

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next)
        setAnchor(null)
      }}
      open={open}
    >
      <PopoverTrigger asChild>
        <Button
          aria-label={ariaLabel}
          className={cn('h-9 justify-start gap-2 font-normal', className)}
          disabled={disabled}
          id={id}
          type="button"
          variant="outline"
        >
          <CalendarIcon aria-hidden className="size-4" />
          {shownPreset ? (
            <span>
              {shownPreset} <span className="text-muted-foreground">· {rangeLabel(value)}</span>
            </span>
          ) : (
            rangeLabel(value)
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-auto max-w-[calc(100vw-2rem)] flex-col p-0 sm:flex-row">
        {presets.length ? (
          <div
            aria-label="Presets"
            className="flex flex-wrap gap-1 border-b p-2 sm:w-36 sm:flex-col sm:flex-nowrap sm:border-r sm:border-b-0"
            role="group"
          >
            {presets.map((label) => (
              <Button
                aria-pressed={label === shownPreset}
                className="justify-start aria-pressed:bg-accent"
                key={label}
                onClick={() => {
                  onPreset?.(label)
                  setOpen(false)
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                {label}
              </Button>
            ))}
          </div>
        ) : null}
        <div>
          <Calendar
            autoFocus
            // Days between the ends are tinted, not filled like the ends.
            classNames={{
              range_middle: '[&>button]:bg-accent! [&>button]:text-accent-foreground!',
            }}
            defaultMonth={dayDate(value.from)}
            disabled={bounds}
            mode="range"
            numberOfMonths={2}
            onSelect={(_, picked) => {
              const day = dayKey(picked)
              if (!anchor) return setAnchor(day)
              setAnchor(null)
              setOpen(false)
              onChange(day < anchor ? { from: day, to: anchor } : { from: anchor, to: day })
            }}
            selected={start ? { from: start, to: end } : undefined}
          />
          <p aria-live="polite" className="px-3 pb-3 text-xs text-muted-foreground">
            {anchor ? 'Now pick the last day.' : 'Pick the first day, then the last.'}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}
