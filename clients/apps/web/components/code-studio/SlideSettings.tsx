'use client'

import * as React from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import {
  CODE_TRANSITIONS,
  type CodeDocument,
  type CodeTransition,
} from '@/lib/code-studio/document'
import { updateSlide } from '@/lib/code-studio/edit'
import { slideHold } from '@/lib/code-studio/timeline'

const TRANSITION_LABELS: Record<CodeTransition, string> = {
  morph: 'Morph tokens',
  type: 'Type new lines',
  highlight: 'Crossfade',
  cut: 'Cut',
}

/** One slide as a video step: its caption, its transition in and how long it holds. */
export function SlideSettings({
  document,
  slideIndex,
  disabled,
  onChange,
}: {
  document: CodeDocument
  slideIndex: number
  disabled: boolean
  onChange: (document: CodeDocument) => void
}) {
  const id = React.useId()
  const slide = document.slides[slideIndex]!
  const set = (patch: Parameters<typeof updateSlide>[2]) =>
    onChange(updateSlide(document, slideIndex, patch))
  const hold = slideHold(slide)
  return (
    <section className="space-y-3 border-t px-4 py-4">
      <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Slide {slideIndex + 1} · video
      </h2>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-caption`}>Caption</Label>
        <Input
          id={`${id}-caption`}
          value={slide.caption}
          maxLength={280}
          placeholder="Shown under the code in videos"
          disabled={disabled}
          onChange={(event) => set({ caption: event.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-transition`}>
          {slideIndex === 0 ? 'Opening' : 'Transition from the previous slide'}
        </Label>
        <Select
          value={slideIndex === 0 && slide.transition !== 'type' ? 'cut' : slide.transition}
          disabled={disabled}
          onValueChange={(transition) => set({ transition: transition as CodeTransition })}
        >
          <SelectTrigger id={`${id}-transition`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CODE_TRANSITIONS.filter(
              (item) => slideIndex > 0 || item === 'type' || item === 'cut'
            ).map((item) => (
              <SelectItem key={item} value={item}>
                {slideIndex === 0 && item === 'cut' ? 'Show at once' : TRANSITION_LABELS[item]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {slide.transition !== 'cut' && (slideIndex > 0 || slide.transition === 'type') ? (
        <Slider
          label="Transition length"
          min={100}
          max={5_000}
          step={100}
          value={[slide.transitionDuration]}
          valueDisplay={`${(slide.transitionDuration / 1000).toFixed(1)} s`}
          disabled={disabled}
          onValueChange={([value]) => set({ transitionDuration: value! })}
        />
      ) : null}
      <Slider
        label="Hold"
        min={300}
        max={20_000}
        step={100}
        value={[slide.duration]}
        valueDisplay={
          hold > slide.duration
            ? `${(hold / 1000).toFixed(1)} s (script)`
            : `${(slide.duration / 1000).toFixed(1)} s`
        }
        disabled={disabled}
        onValueChange={([value]) => set({ duration: value! })}
      />
    </section>
  )
}
