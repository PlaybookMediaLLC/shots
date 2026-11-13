'use client'

import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

/**
 * Post a version as a story: one image or video, shown for 24 hours, without
 * its text. Instagram and Facebook Pages take stories.
 */
export function StoryToggle({
  checked,
  disabled,
  id,
  note,
  onCheckedChange,
}: {
  checked: boolean
  disabled: boolean
  id: string
  /** What else a story on this platform leaves out. */
  note: string
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        checked={checked}
        disabled={disabled}
        id={id}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <div className="grid gap-0.5">
        <Label htmlFor={id}>Post as a story</Label>
        <p>
          One image or video, shown for 24 hours, without a caption: the text goes to your other
          platforms. {note}
        </p>
      </div>
    </div>
  )
}
