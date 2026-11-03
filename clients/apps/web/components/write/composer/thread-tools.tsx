'use client'

import * as React from 'react'
import type { PlateEditor } from '@shots/platejs-editor/platejs/react'
import type { Value } from '@shots/platejs-editor/platejs'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { draftPlainText } from '@/lib/content-drafts/serialize'
import { splitThread } from '@/lib/write/split-thread'
import type { DraftChannel, PlateBody, VersionOptions } from '@/lib/write/document'

/** Explicit, undoable thread creation using the version's persisted length preference. */
export function ThreadTools({
  editor,
  channel,
  limit,
  options,
  onChange,
  pasted,
  onSplit,
}: {
  editor: React.RefObject<PlateEditor | null>
  channel: DraftChannel
  limit: number
  options: VersionOptions
  onChange: (options: VersionOptions) => void
  pasted?: boolean
  onSplit?: () => void
}) {
  const maxLength = Math.min(options.splitLimit ?? limit, limit)
  const performSplit = React.useCallback(() => {
    const current = editor.current
    if (!current) return
    try {
      const body = splitThread(current.children as PlateBody, channel, maxLength, options.numbering)
      current.tf.withNewBatch(() =>
        current.tf.withoutNormalizing(() => {
          for (let index = current.children.length - 1; index >= 0; index--)
            current.tf.removeNodes({ at: [index] })
          current.tf.insertNodes(body as Value, { at: [0] })
        })
      )
      current.tf.select(current.api.end([]))
      current.tf.focus()
      onSplit?.()
      toast.success('Thread created. Review the preview before scheduling.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The text could not be split.')
    }
  }, [editor, channel, maxLength, options.numbering, onSplit])
  const lastPaste = React.useRef(false)
  React.useEffect(() => {
    if (!pasted) {
      lastPaste.current = false
      return
    }
    if (!options.splitOnPaste || lastPaste.current) return
    lastPaste.current = true
    // Run after Plate's synchronous paste transaction has finished.
    window.setTimeout(performSplit, 0)
  }, [pasted, options.splitOnPaste, performSplit])
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pb-3 text-xs">
      {pasted ? (
        <p className="w-full text-muted-foreground" role="status">
          Pasted content is ready. Make thread splits it at your chosen length while keeping its
          formatting and links.
        </p>
      ) : null}
      <Label className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
        Characters per post
        <Input
          aria-label="Characters per post"
          className="h-7 w-24"
          type="number"
          min={25}
          max={limit}
          value={maxLength}
          onChange={(event) => {
            const value = Number(event.target.value)
            if (Number.isInteger(value) && value >= 25 && value <= limit)
              onChange({ ...options, splitLimit: value })
          }}
        />
      </Label>
      <Label className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
        <Checkbox
          checked={options.splitOnPaste ?? false}
          onCheckedChange={(checked) => onChange({ ...options, splitOnPaste: checked === true })}
        />
        Split automatically on paste
      </Label>
      <Button
        className="h-7 rounded-full px-3 text-xs"
        size={null}
        variant="outline"
        onClick={() => {
          performSplit()
        }}
      >
        Make thread
      </Button>
      <Button
        className="h-7 rounded-full px-3 text-xs"
        size={null}
        variant="ghost"
        onClick={async () => {
          const current = editor.current
          if (!current) return
          try {
            const text = draftPlainText(current.children)
            await navigator.clipboard.writeText(text)
            toast.success('Text copied.')
          } catch {
            toast.error('Copy failed. Select the text and copy it using your keyboard.')
          }
        }}
      >
        Copy text
      </Button>
    </div>
  )
}
