'use client'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * A small choice of two or three views, drawn as the batch page's other
 * choices are. The design system's SegmentedControl is full width and tall on
 * small screens, made for the editor's panels.
 */
export function Segmented<T extends string>({
  disabled,
  label,
  onChange,
  options,
  value,
}: {
  disabled?: boolean
  label: string
  onChange: (value: T) => void
  options: readonly (readonly [T, string])[]
  value: T
}) {
  return (
    <div
      aria-label={label}
      className="inline-flex justify-self-start rounded-md border border-border p-0.5"
      role="group"
    >
      {options.map(([option, text]) => (
        <Button
          aria-pressed={value === option}
          disabled={disabled}
          className={cn(
            'h-7 rounded px-2.5 text-label',
            value === option
              ? 'bg-foreground/[0.08] text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          )}
          key={option}
          onClick={() => onChange(option)}
          size={null}
          type="button"
          variant="custom"
        >
          {text}
        </Button>
      ))}
    </div>
  )
}
