'use client'

import dynamic from 'next/dynamic'
import { useMemo, useState } from 'react'
import type { Value } from '@shots/platejs-editor/platejs'
import type { PlateEditor } from '@shots/platejs-editor/platejs/react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  importedBody,
  importedPosts,
  splitThread,
  THREAD_POST_LIMIT,
} from '@/lib/write/import-text'
import type { SplitResult } from '@/lib/write/import-text.worker'
import { useWorkerAnswer } from '@/lib/write/use-worker-answer'
import type { DraftChannel } from '@/lib/write/document'
import { withLeadMedia, type PostMedia } from '@/lib/write/screenshot-post'
import { postRanges } from '@/components/drafts/thread'
import { toast } from 'sonner'

const LibraryAssetPicker = dynamic(
  () =>
    import('@/components/platform-hub/LibraryAssetPicker').then(
      (module) => module.LibraryAssetPicker
    ),
  { ssr: false }
)

const startSplit = () =>
  new Worker(new URL('../../../lib/write/import-text.worker.ts', import.meta.url), {
    type: 'module',
  })

const SPLIT_FAILED: SplitResult = { posts: [], error: 'The split preview could not load.' }

/** Preview a paste before appending ordinary, editable Plate posts. */
export function PasteThreadDialog({
  channel,
  editor,
  limit,
  onClose,
}: {
  channel: DraftChannel
  editor: React.MutableRefObject<PlateEditor | null>
  limit: number
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [length, setLength] = useState(limit)
  const [automatic, setAutomatic] = useState(false)
  // A screenshot belongs on the post that opens the explanation, not under it.
  const [lead, setLead] = useState<PostMedia[]>([])
  const [picking, setPicking] = useState(false)
  const explicit = useMemo(() => {
    try {
      return { posts: importedPosts(text), error: '' }
    } catch (error) {
      return { posts: [], error: (error as Error).message }
    }
  }, [text])
  // The split by length runs in a worker (see import-text.worker.ts).
  const request = useMemo(
    (): Parameters<typeof splitThread> => [text, channel, length],
    [text, channel, length]
  )
  const { answer: split, pending: splitting } = useWorkerAnswer(
    startSplit,
    automatic ? request : undefined,
    SPLIT_FAILED
  )
  const preview = automatic ? (split ?? { posts: [], error: '' }) : explicit
  const insert = () => {
    const current = editor.current
    if (!current || !preview.posts.length) return
    if (postRanges(current.children).length + preview.posts.length > THREAD_POST_LIMIT) {
      toast.error(`The combined thread would exceed ${THREAD_POST_LIMIT} posts.`)
      return
    }
    const body = withLeadMedia(importedBody(preview.posts), lead)
    current.tf.insertNodes(body as Value, { at: [current.children.length] })
    onClose()
    current.tf.focus()
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Paste as thread</DialogTitle>
          <DialogDescription>
            Separate posts with a line containing --- or four line breaks. Review the split before
            adding posts.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label="Thread text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={8}
          maxLength={100_000}
        />
        <Label className="flex gap-2 text-sm">
          <Checkbox
            checked={automatic}
            onCheckedChange={(checked) => setAutomatic(checked === true)}
          />
          Split by post length
        </Label>
        {automatic && (
          <Label className="block text-sm">
            Maximum post length
            <Input
              type="number"
              min={23}
              max={limit}
              value={length}
              onChange={(event) => setLength(Number(event.target.value))}
            />
          </Label>
        )}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Button onClick={() => setPicking(true)} size="sm" type="button" variant="outline">
            {lead.length ? 'Change opening image' : 'Attach to the opening post'}
          </Button>
          {lead.length ? (
            <>
              <span className="text-xs text-muted-foreground">
                {lead.length} attached to post 1
              </span>
              <Button onClick={() => setLead([])} size="sm" type="button" variant="ghost">
                Remove
              </Button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              A screenshot on post 1 explains what the thread is about.
            </span>
          )}
        </div>
        {picking ? (
          <LibraryAssetPicker
            channel={channel}
            onClose={() => setPicking(false)}
            onInsert={setLead}
          />
        ) : null}
        {preview.error && <p role="alert">{preview.error}</p>}
        <ol className="grid max-h-60 gap-3 overflow-auto text-sm">
          {preview.posts.map((post, index) => (
            <li className="whitespace-pre-wrap rounded border p-2" key={index}>
              <strong>{index + 1}.</strong> {post}
              {index === 0 && lead.length ? (
                <span className="mt-1 block text-xs text-muted-foreground">
                  With {lead.length === 1 ? 'the attachment' : `${lead.length} attachments`}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
        <Button
          disabled={splitting || !preview.posts.length || Boolean(preview.error) || length > limit}
          onClick={insert}
        >
          {splitting ? 'Splitting…' : `Append ${preview.posts.length} posts`}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
