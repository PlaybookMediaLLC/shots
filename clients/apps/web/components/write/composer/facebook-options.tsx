'use client'

import type { FacebookOptions as Options } from 'screenshot-studio-backend-sdk'
import { StoryToggle } from './story-toggle'

/** A Facebook Page post's settings: a story instead of a feed post. */
export function FacebookOptions({
  disabled,
  onChange,
  value,
}: {
  disabled: boolean
  onChange: (value: Options | undefined) => void
  value: Options | undefined
}) {
  return (
    <div
      className="grid w-full divide-y divide-[var(--divider,var(--border))] text-ui text-muted-foreground [&>*]:px-4 [&>*]:py-2.5 [&_label]:text-ui-lg [&_label]:font-medium [&_label]:text-foreground"
      data-option-rows
      data-testid="facebook-options"
    >
      <StoryToggle
        checked={value?.placement === 'story'}
        disabled={disabled}
        id="facebook-story"
        note="A story takes no first comment."
        onCheckedChange={(story) => onChange(story ? { placement: 'story' } : undefined)}
      />
    </div>
  )
}
