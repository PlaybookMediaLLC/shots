'use client'

import * as React from 'react'
import { PlusIcon as Add01Icon } from '@phosphor-icons/react/dist/ssr/Plus'
import { XIcon as Cancel01Icon } from '@phosphor-icons/react/dist/ssr/X'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  customTarget,
  EXPORT_SIZE_PRESETS,
  type ExportTarget,
  SIZE_GROUP_LABELS,
  sizeGroupSchema,
  toggleTarget,
} from '@/lib/export/sizes'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'

/** The preset groups shown in the picker, in order. */
const PICKER_GROUPS = sizeGroupSchema.options.filter(
  (group) => group !== 'canvas' && group !== 'custom'
)

/**
 * The target sizes of an export: the chosen sizes as a list, and a picker
 * of platform presets (social, marketing, presentation, App Store) plus a
 * custom size. `extra` lists sizes offered above the presets, such as the
 * design's own canvas.
 */
export function SizePicker({
  extra = [],
  onChange,
  value,
}: {
  extra?: readonly ExportTarget[]
  onChange: (targets: ExportTarget[]) => void
  value: readonly ExportTarget[]
}) {
  const [open, setOpen] = React.useState(false)
  const [custom, setCustom] = React.useState({ height: '', width: '' })
  const [customError, setCustomError] = React.useState<string | null>(null)
  const chosen = new Set(value.map((target) => target.id))

  const addCustom = (event: React.FormEvent) => {
    event.preventDefault()
    try {
      const target = customTarget(Number(custom.width), Number(custom.height))
      if (!chosen.has(target.id)) onChange([...value, target])
      setCustom({ height: '', width: '' })
      setCustomError(null)
    } catch (error) {
      setCustomError(error instanceof Error ? error.message : 'Enter a valid size.')
    }
  }

  const option = (target: ExportTarget) => {
    const id = `size-${target.id}`
    return (
      <Label
        className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-foreground/[0.05]"
        htmlFor={id}
        key={target.id}
      >
        <Checkbox
          checked={chosen.has(target.id)}
          id={id}
          onCheckedChange={() => onChange(toggleTarget(value, target))}
        />
        <span className="min-w-0 flex-1 truncate text-foreground">{target.label}</span>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
          {target.width}×{target.height}
        </span>
      </Label>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-ui-lg font-medium text-foreground">Sizes</span>
        <Popover onOpenChange={setOpen} open={open}>
          <PopoverTrigger asChild>
            <Button variant="custom" size={null}
              className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              type="button"
            >
              <Add01Icon size={13} />
              Add sizes
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-0" collisionPadding={16} side="left">
            <div
              className="max-h-[min(420px,60vh)] overflow-y-auto p-2"
              role="group"
              aria-label="Export sizes"
            >
              {extra.length > 0 ? <div className="pb-1">{extra.map(option)}</div> : null}
              {PICKER_GROUPS.map((group) => (
                <div className="pb-1" key={group}>
                  <p className="px-2 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {SIZE_GROUP_LABELS[group]}
                  </p>
                  {EXPORT_SIZE_PRESETS.filter((preset) => preset.group === group).map(option)}
                </div>
              ))}
            </div>
            <form
              className="space-y-1.5 border-t border-foreground/[0.08] p-3"
              onSubmit={addCustom}
            >
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Custom
              </p>
              <div className="flex items-center gap-1.5">
                <Input
                  aria-label="Custom width"
                  className="h-8 px-2 text-xs"
                  inputMode="numeric"
                  onChange={(event) =>
                    setCustom((size) => ({ ...size, width: event.target.value }))
                  }
                  placeholder="Width"
                  value={custom.width}
                />
                <span className="text-xs text-muted-foreground">×</span>
                <Input
                  aria-label="Custom height"
                  className="h-8 px-2 text-xs"
                  inputMode="numeric"
                  onChange={(event) =>
                    setCustom((size) => ({ ...size, height: event.target.value }))
                  }
                  placeholder="Height"
                  value={custom.height}
                />
                <Button variant="custom" size={null}
                  className="h-8 shrink-0 cursor-pointer rounded-md bg-foreground px-2.5 text-xs font-medium text-background hover:opacity-90"
                  type="submit"
                >
                  Add
                </Button>
              </div>
              {customError ? (
                <p className="text-[11px] text-destructive" role="alert">
                  {customError}
                </p>
              ) : null}
            </form>
          </PopoverContent>
        </Popover>
      </div>
      {value.length === 0 ? (
        <p className="rounded-md border border-dashed border-foreground/15 p-2 text-xs text-muted-foreground">
          Pick at least one size.
        </p>
      ) : (
        <ul aria-label="Chosen sizes" className="flex flex-wrap gap-1">
          {value.map((target) => (
            <li
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md border border-foreground/10 bg-foreground/[0.04] pl-2 pr-1 text-xs'
              )}
              key={target.id}
            >
              <span className="text-foreground">{target.label}</span>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                {target.width}×{target.height}
              </span>
              <Button variant="custom" size={null}
                aria-label={`Remove ${target.label}`}
                className="grid size-5 cursor-pointer place-items-center rounded text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground"
                onClick={() => onChange(toggleTarget(value, target))}
                type="button"
              >
                <Cancel01Icon size={11} />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
