'use client'

import { CaretDownIcon } from '@phosphor-icons/react/dist/ssr/CaretDown'
import { CheckIcon } from '@phosphor-icons/react/dist/ssr/Check'
import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/ssr/MagnifyingGlass'
import { Command } from 'cmdk'
import { useId, useRef, useState, type ReactNode } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { selectTriggerClassName } from '@/components/ui/select'
import { cn } from '@/lib/utils'

/** One choice: `label` is what people read, `keywords` what else finds it. */
export type ComboboxOption = {
  value: string
  label: string
  description?: string
  keywords?: string[]
  disabled?: boolean
}

/** The menu row classes every cmdk list here shares. */
export const commandItemClassName =
  'relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground'

/**
 * A searchable select: the trigger reads like a Select; its menu has a search
 * field, fuzzy matches on label and keywords, and "No matches" when none do.
 */
export function Combobox({
  className,
  disabled,
  emptyText = 'No matches',
  id,
  onValueChange,
  options,
  placeholder = 'Choose…',
  searchPlaceholder = 'Search',
  size = 'default',
  value,
  valueLabel,
  'aria-describedby': describedBy,
  'aria-label': ariaLabel,
}: {
  className?: string
  disabled?: boolean
  emptyText?: string
  id?: string
  onValueChange: (value: string) => void
  /** A function is called only while the menu is open, for lists costly to build. */
  options: readonly ComboboxOption[] | (() => readonly ComboboxOption[])
  placeholder?: string
  searchPlaceholder?: string
  size?: 'default' | 'sm'
  value: string | null
  /** What the trigger shows, when it is not the chosen option's label. */
  valueLabel?: ReactNode
  'aria-describedby'?: string
  'aria-label'?: string
}) {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const list = typeof options === 'function' ? (open ? options() : []) : options
  const shown = valueLabel ?? list.find((option) => option.value === value)?.label

  return (
    // Modal: inside a Dialog, a non-modal popover cannot scroll with the wheel.
    <Popover modal onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-controls={open ? listId : undefined}
          aria-describedby={describedBy}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={ariaLabel}
          className={cn(selectTriggerClassName, 'min-w-0', className)}
          data-placeholder={shown ? undefined : ''}
          data-size={size}
          data-slot="select-trigger"
          disabled={disabled}
          id={id}
          role="combobox"
          type="button"
        >
          <span className="min-w-0 truncate" data-slot="select-value">
            {shown ?? placeholder}
          </span>
          <CaretDownIcon className="size-4 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) min-w-[16rem] p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          // Open on the chosen row, not at the top of a long list.
          requestAnimationFrame(() =>
            document
              .getElementById(listId)
              ?.querySelector('[data-selected="true"]')
              ?.scrollIntoView({ block: 'center' })
          )
        }}
      >
        <Command defaultValue={value ?? undefined} label={ariaLabel ?? searchPlaceholder} loop>
          <div className="flex items-center gap-2 border-b px-3">
            <MagnifyingGlassIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <Command.Input
              // A new search starts at its best match, not wherever the list was scrolled.
              onValueChange={() => listRef.current?.scrollTo({ top: 0 })}
              autoFocus
              className="h-9 w-full min-w-0 bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
              placeholder={searchPlaceholder}
            />
          </div>
          <Command.List className="max-h-80 overflow-y-auto p-1" id={listId} ref={listRef}>
            <Command.Empty className="px-2 py-6 text-center text-sm text-muted-foreground">
              {emptyText}
            </Command.Empty>
            {list.map((option) => (
              <Command.Item
                className={commandItemClassName}
                disabled={option.disabled}
                key={option.value}
                keywords={[option.label, ...(option.keywords ?? [])]}
                onSelect={() => {
                  onValueChange(option.value)
                  setOpen(false)
                }}
                value={option.value}
              >
                <span className="grid min-w-0">
                  <span className="truncate">{option.label}</span>
                  {option.description ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </span>
                {option.value === value ? (
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
