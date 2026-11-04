'use client'

import * as React from 'react'
import { toast } from 'sonner'
import type { PlateEditor } from '@shots/platejs-editor/platejs/react'
import type { EditorUploadFile } from '@shots/platejs-editor/lib'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { postRanges } from '@/components/drafts/thread'
import { call } from '@/lib/content-drafts/client'
import { assetContentUrl } from '@/lib/editor/services'

/** Media stays in Plate and the existing asset library; reordering never uploads. */
export function MediaImportDialog({
  editor,
  uploadFile,
  draftId,
  returnedAsset,
  onClose,
}: {
  editor: PlateEditor
  uploadFile: EditorUploadFile
  draftId: string
  returnedAsset?: string
  onClose: () => void
}) {
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0)
  const drag = React.useRef<{ index: number; snapshot: string } | null>(null)
  const [post, setPost] = React.useState(0)
  const [url, setURL] = React.useState('')
  const [candidate, setCandidate] = React.useState<{ image: string; title: string | null } | null>(
    null
  )
  const [query, setQuery] = React.useState('')
  const [gifs, setGIFs] = React.useState<Array<{ id: string; title: string; url: string }>>([])
  const [busy, setBusy] = React.useState(false)
  const [attached, setAttached] = React.useState(false)
  const ranges = postRanges(editor.children)
  const media = editor.children.flatMap((node, index) =>
    typeof node.assetId === 'string' && ['img', 'video', 'file'].includes(String(node.type))
      ? [
          {
            index,
            assetId: node.assetId,
            type: String(node.type),
            url: String(node.url ?? ''),
            post: ranges.findIndex(([start, end]) => index >= start && index < end),
          },
        ]
      : []
  )
  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The media could not be loaded.')
    } finally {
      setBusy(false)
    }
  }
  // The stored type, when known, lets the composer check each destination's formats.
  const insert = (assetId: string, source: string, mimeType?: string) => {
    const range = postRanges(editor.children)[post]
    if (!range) throw new Error('That post changed. Choose a destination again.')
    editor.tf.insertNodes(
      {
        type: 'img',
        assetId,
        url: source,
        ...(mimeType ? { mimeType } : {}),
        children: [{ text: '' }],
      },
      { at: [range[1]] }
    )
    refresh()
  }
  const upload = async (blob: Blob, name: string) => {
    if (!blob.type.startsWith('image/') || blob.size > 20 * 1024 * 1024)
      throw new Error('Choose an image smaller than 20 MB.')
    const saved = await uploadFile(new File([blob], name, { type: blob.type }))
    if (!saved.assetId) throw new Error('The image was not saved to the workspace.')
    insert(saved.assetId, saved.url, blob.type)
    toast.success('Image attached. Review the channel’s media limits before scheduling.')
  }
  const move = (from: number, to: number) => {
    editor.tf.moveNodes({ at: [from], to: [to] })
    refresh()
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto"
        data-testid="draft-media-tools"
        data-local-dropzone=""
        data-revision={revision}
      >
        <DialogHeader>
          <DialogTitle>Draft media</DialogTitle>
        </DialogHeader>
        <Label className="grid gap-1 text-sm">
          Destination post
          <Select value={String(post)} onValueChange={(value) => setPost(Number(value))}>
            <SelectTrigger aria-label="Media destination post">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ranges.map((_, index) => (
                <SelectItem key={index} value={String(index)}>
                  Post {index + 1}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Label>
        {returnedAsset && !attached && (
          <div className="grid gap-2">
            <p>Review the framed export before attaching it.</p>
            <img
              alt="Framed export"
              src={`${assetContentUrl(returnedAsset)}?variant=thumbnail`}
              className="max-h-40 object-contain"
            />
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await call(`/api/v1/assets/${encodeURIComponent(returnedAsset)}/download-url`)
                  insert(returnedAsset, assetContentUrl(returnedAsset))
                  setAttached(true)
                })
              }
            >
              {busy ? 'Attaching…' : 'Attach framed export'}
            </Button>
          </div>
        )}
        <ul className="grid gap-3">
          {media.map((item, at) => (
            <li
              key={`${item.assetId}-${item.index}`}
              data-testid="draft-media-item"
              draggable={!busy}
              onDragStart={(event) => {
                // Plate's window-level react-dnd backend cancels unknown drag
                // types. This dialog owns this gesture independently of blocks.
                event.stopPropagation()
                drag.current = { index: item.index, snapshot: JSON.stringify(editor.children) }
                event.dataTransfer.setData('application/x-shots-draft-media', String(item.index))
                event.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={(event) => {
                event.stopPropagation()
                drag.current = null
              }}
              onDragOver={(event) => {
                if (!busy && event.dataTransfer.types.includes('application/x-shots-draft-media')) {
                  event.stopPropagation()
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                }
              }}
              onDrop={(event) => {
                if (busy || !event.dataTransfer.types.includes('application/x-shots-draft-media'))
                  return
                event.stopPropagation()
                event.preventDefault()
                const from = drag.current
                drag.current = null
                if (!from || from.index === item.index) return
                if (from.snapshot !== JSON.stringify(editor.children)) {
                  toast.error('The document changed during the drag. Try again.')
                  return
                }
                move(from.index, item.index)
              }}
              className="flex flex-wrap items-center gap-2 rounded border p-2"
            >
              <Button
                variant="custom"
                size={null}
                type="button"
                aria-label={`Drag media ${at + 1}`}
                title="Drag to reorder; use Move earlier or Move later with a keyboard"
                draggable={!busy}
                disabled={busy}
                className="cursor-grab rounded p-2 text-muted-foreground active:cursor-grabbing"
              >
                ⠿
              </Button>
              {item.type === 'img' && (
                <img
                  src={`${assetContentUrl(item.assetId)}?variant=thumbnail`}
                  alt={`Media ${at + 1}`}
                  draggable={false}
                  className="size-16 object-contain"
                />
              )}
              <span>
                Post {item.post + 1}, media {at + 1}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={at === 0 || busy}
                onClick={() => move(item.index, media[at - 1].index)}
              >
                Move earlier
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={at === media.length - 1 || busy}
                onClick={() => move(item.index, media[at + 1].index)}
              >
                Move later
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={item.post === post || busy}
                onClick={() => {
                  const end = postRanges(editor.children)[post]?.[1]
                  if (end !== undefined) move(item.index, item.index < end ? end - 1 : end)
                }}
              >
                Move to post {post + 1}
              </Button>
              {item.type === 'img' && (
                <a
                  className="text-sm underline"
                  href={`/?asset=${encodeURIComponent(item.assetId)}&fromDraft=${encodeURIComponent(draftId)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Frame in Shots editor
                </a>
              )}
            </li>
          ))}
        </ul>
        <form
          className="grid gap-2 border-t pt-3"
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              const card = await call<{ image: string | null; title: string | null }>(
                `/api/v1/content-drafts/link-card?${new URLSearchParams({ url })}`
              )
              if (!card.image) throw new Error('This page does not provide a preview image.')
              setCandidate({ image: card.image, title: card.title })
            })
          }}
        >
          <Label className="grid gap-1">
            Image from a link
            <Input
              aria-label="Page URL for image"
              type="url"
              required
              value={url}
              onChange={(event) => {
                setURL(event.target.value)
                setCandidate(null)
              }}
              className="rounded border bg-background p-2"
            />
          </Label>
          <Button disabled={busy} type="submit" variant="outline">
            Find page image
          </Button>
        </form>
        {candidate && (
          <div className="grid gap-2">
            <p>{candidate.title ?? 'Page image'}</p>
            <img
              className="max-h-40 object-contain"
              alt="Page preview"
              src={`/api/link-preview/image?${new URLSearchParams({ url: candidate.image })}`}
            />
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const response = await fetch(
                    `/api/link-preview/image?${new URLSearchParams({ url: candidate.image })}`
                  )
                  if (!response.ok) throw new Error('The page image could not be downloaded.')
                  await upload(await response.blob(), 'link-image.jpg')
                  setCandidate(null)
                })
              }
            >
              Attach 1200 × 630 image
            </Button>
          </div>
        )}
        <form
          className="grid gap-2 border-t pt-3"
          onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              const result = await call<{
                items: { id: string; title: string; previewUrl: string; sourceUrl: string }[]
              }>(`/api/v1/content-drafts/giphy?${new URLSearchParams({ q: query })}`)
              setGIFs(
                result.items.map((item) => ({
                  id: item.id,
                  title: item.title,
                  url: item.previewUrl,
                }))
              )
            })
          }}
        >
          <Label className="grid gap-1">
            GIF search
            <Input
              aria-label="Search GIFs"
              maxLength={50}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              disabled={busy}
              className="rounded border bg-background p-2"
            />
          </Label>
          <Button type="submit" disabled={!query.trim() || busy} variant="outline">
            Search GIPHY
          </Button>
          <p className="text-xs text-muted-foreground">
            Search and attachment require an approved GIPHY integration.
          </p>
        </form>
        <div className="grid grid-cols-3 gap-2">
          {gifs.map((gif) => (
            <Button
              variant="custom"
              size={null}
              type="button"
              key={gif.id}
              disabled={busy}
              aria-label={`Attach ${gif.title}`}
              onClick={() =>
                void run(async () => {
                  const result = await call<{ assetId: string; sourceUrl: string }>(
                    '/api/v1/content-drafts/giphy',
                    { method: 'POST', body: { id: gif.id } }
                  )
                  insert(result.assetId, assetContentUrl(result.assetId), 'image/gif')
                })
              }
            >
              <img src={gif.url} alt={gif.title} loading="lazy" />
            </Button>
          ))}
        </div>
        {gifs.length > 0 && (
          <a
            href="https://giphy.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs underline"
          >
            Powered by GIPHY
          </a>
        )}
        <Button onClick={onClose} variant="outline">
          Done
        </Button>
      </DialogContent>
    </Dialog>
  )
}
