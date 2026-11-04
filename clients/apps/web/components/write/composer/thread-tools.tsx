'use client'

import * as React from 'react'
import type { PlateEditor } from '@shots/platejs-editor/platejs/react'
import type { Value } from '@shots/platejs-editor/platejs'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { postRanges } from '@/components/drafts/thread'
import { draftPlainText, serializeDraft } from '@/lib/content-drafts/serialize'
import { bodyPosts } from '@/lib/write/versions'
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
  // A split on paste is shown first: where each post breaks, before anything changes.
  const [preview, setPreview] = React.useState<PlateBody | null>(null)
  const apply = React.useCallback((body: PlateBody) => {
    const current = editor.current
    if (!current) return
    try {
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
  }, [editor, onSplit])
  const split = React.useCallback((): PlateBody | null => {
    const current = editor.current
    if (!current) return null
    try {
      return splitThread(current.children as PlateBody, channel, maxLength, options.numbering)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The text could not be split.')
      return null
    }
  }, [editor, channel, maxLength, options.numbering])
  const performSplit = () => {
    const body = split()
    if (body) apply(body)
  }
  const lastPaste = React.useRef(false)
  React.useEffect(() => {
    if (!pasted) {
      lastPaste.current = false
      return
    }
    if (!options.splitOnPaste || lastPaste.current) return
    lastPaste.current = true
    // After Plate's synchronous paste transaction has finished.
    window.setTimeout(() => {
      const body = split()
      const before = postRanges((editor.current?.children ?? []) as Value).length
      if (body && bodyPosts(body).length > before) setPreview(body)
    }, 0)
  }, [editor, pasted, options.splitOnPaste, split])
  const posts = preview ? serializeDraft(preview, channel).posts : []
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-4 py-3 text-ui">
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
        className="h-8 rounded-md px-3 text-ui"
        size={null}
        variant="outline"
        onClick={() => {
          performSplit()
        }}
      >
        Make thread
      </Button>
      <Dialog
        onOpenChange={(open) => {
          if (open) return
          setPreview(null)
          onSplit?.()
        }}
        open={preview !== null}
      >
        <DialogContent className="max-w-lg" data-testid="split-preview">
          <DialogHeader>
            <DialogTitle>Split into {posts.length} posts?</DialogTitle>
            <DialogDescription>
              Where your paste breaks at {maxLength} characters a post. Nothing changes until you
              split.
            </DialogDescription>
          </DialogHeader>
          <ol className="grid max-h-[50dvh] gap-2 overflow-y-auto">
            {posts.map((post, index) => (
              <li className="grid gap-1 rounded-lg border border-border p-3" key={index}>
                <p className="text-caption text-muted-foreground">
                  Post {index + 1} · {post.length} / {limit}
                </p>
                <p className="whitespace-pre-wrap text-ui text-foreground">{post.caption}</p>
              </li>
            ))}
          </ol>
          <DialogFooter>
            <Button
              onClick={() => {
                setPreview(null)
                onSplit?.()
              }}
              type="button"
              variant="outline"
            >
              Keep as one post
            </Button>
            <Button
              onClick={() => {
                if (preview) apply(preview)
                setPreview(null)
              }}
              type="button"
            >
              Split into {posts.length} posts
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Button
        className="h-8 rounded-md px-3 text-ui"
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
