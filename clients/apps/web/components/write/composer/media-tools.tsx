'use client'
import * as React from 'react'
import { useEditorRef, useEditorSelector } from '@shots/platejs-editor/platejs/react'
import type { TElement } from '@shots/platejs-editor/platejs'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { postRanges } from '@/components/drafts/thread'
import {
  attachmentEntry,
  attachmentsIn,
  copyAttachment,
  ensureAttachmentIds,
  moveAttachment,
  moveAttachmentRelative,
  removeAttachment,
} from '@/lib/write/media-operations'
import { DescribeImages } from './describe-images'
import { MediaFrame } from './media-frame'
import { MediaThumb } from './media-thumb'
import { LinkImage } from './link-image'
import { GiphyPicker } from './giphy-picker'
import { PhotoTags } from './photo-tags'

/**
 * Media controls operate on the editor's nodes, with native undo and autosave.
 * The toolbar's More menu and the slash menu open them through `tool`.
 */
export function MediaTools({
  channel,
  draftId,
  onClose,
  setId,
  onDescriptionSaved,
  tool,
}: {
  channel: string
  draftId: string
  onClose: () => void
  setId: string | null
  onDescriptionSaved: (assetId: string, alt: string) => void
  tool: 'gif' | 'link-image' | 'media' | null
}) {
  const editor = useEditorRef()
  const body = useEditorSelector((current) => current.children, [])
  const [alt, setAlt] = React.useState<string | null>(null)
  const [frame, setFrame] = React.useState<string | null>(null)
  const [tags, setTags] = React.useState<string | null>(null)
  const managing = tool === 'media'
  React.useEffect(() => {
    if (managing) ensureAttachmentIds(editor)
  }, [editor, managing])
  const ranges = postRanges(body)
  // Derive from the subscribed value, not the stable editor ref: React Compiler
  // can otherwise memoize an initially empty iterator even after an upload.
  const media = body.flatMap((node, index) =>
    attachmentsIn(node).map((attachment) => ({ node: attachment, index }))
  )
  return (
    <>
      {tool === 'gif' ? <GiphyPicker editor={editor} onClose={onClose} /> : null}
      {tool === 'link-image' ? <LinkImage editor={editor} onClose={onClose} /> : null}
      {alt ? (
        <DescribeImages
          editor={editor}
          imageId={alt}
          onClose={() => setAlt(null)}
          onSaved={onDescriptionSaved}
        />
      ) : null}
      {frame ? <MediaFrame editor={editor} id={frame} onClose={() => setFrame(null)} /> : null}
      {tags ? (
        <PhotoTags editor={editor} id={tags} setId={setId} onClose={() => setTags(null)} />
      ) : null}
      <Dialog open={managing} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto" data-testid="media-manager">
          <DialogHeader>
            <DialogTitle>Manage media</DialogTitle>
            <DialogDescription>
              Drag attachments to reorder them or move them to a post. Arrow and move controls work
              with the keyboard. Undo is available in the editor.
            </DialogDescription>
          </DialogHeader>
          {ranges.map(([start, end], post) => {
            const attachments = media.filter((item) => item.index >= start && item.index < end)
            return (
              <section
                key={String(body[start]?.id ?? post)}
                className="rounded border p-2"
                aria-label={`Post ${post + 1} media`}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  moveAttachment(
                    editor,
                    event.dataTransfer.getData('application/x-shots-attachment'),
                    end
                  )
                }}
              >
                <h3 className="mb-2 text-sm">Post {post + 1}</h3>
                {attachments.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Drop an attachment here.</p>
                ) : null}
                {attachments.map(({ node }, position) => (
                  <AttachmentRow
                    key={String(node.id)}
                    draftId={draftId}
                    node={node}
                    post={post}
                    onRemove={() => removeAttachment(editor, node)}
                    postCount={ranges.length}
                    onMove={(target, copy) => {
                      const targetEnd = postRanges(editor.children)[target]?.[1]
                      if (targetEnd !== undefined)
                        (copy ? copyAttachment : moveAttachment)(editor, String(node.id), targetEnd)
                    }}
                    onUp={
                      position > 0
                        ? () =>
                            moveAttachmentRelative(
                              editor,
                              String(node.id),
                              String(attachments[position - 1].node.id)
                            )
                        : undefined
                    }
                    onDown={
                      position < attachments.length - 1
                        ? () =>
                            moveAttachmentRelative(
                              editor,
                              String(node.id),
                              String(attachments[position + 1].node.id),
                              true
                            )
                        : undefined
                    }
                    onDrop={(id) => moveAttachmentRelative(editor, id, String(node.id))}
                    onAlt={() => setAlt(String(node.id))}
                    onFrame={() => setFrame(String(node.id))}
                    onTags={channel === 'x' ? () => setTags(String(node.id)) : undefined}
                    onClearTags={
                      channel !== 'x' && Array.isArray(node.photoTags) && node.photoTags.length
                        ? () => {
                            const entry = attachmentEntry(editor, String(node.id))
                            if (entry) editor.tf.setNodes({ photoTags: [] }, { at: entry[1] })
                          }
                        : undefined
                    }
                  />
                ))}
              </section>
            )
          })}
        </DialogContent>
      </Dialog>
    </>
  )
}

function AttachmentRow({
  draftId,
  node,
  post,
  postCount,
  onRemove,
  onMove,
  onUp,
  onDown,
  onDrop,
  onAlt,
  onFrame,
  onTags,
  onClearTags,
}: {
  draftId: string
  node: TElement
  post: number
  postCount: number
  onRemove: () => void
  onMove: (post: number, copy: boolean) => void
  onUp?: () => void
  onDown?: () => void
  onDrop: (id: string) => void
  onAlt: () => void
  onFrame: () => void
  onTags?: () => void
  onClearTags?: () => void
}) {
  const [destination, setDestination] = React.useState(post)
  const video = node.type === 'video'
  return (
    <div
      className="my-2 flex flex-wrap items-center gap-2 rounded bg-foreground/5 p-2"
      draggable
      onDragStart={(event) => {
        // Keep Plate's window-level HTML5 backend from cancelling this native drag.
        event.stopPropagation()
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('application/x-shots-attachment', String(node.id))
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onDrop={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onDrop(event.dataTransfer.getData('application/x-shots-attachment'))
      }}
      data-attachment-id={String(node.id)}
      data-testid="draft-media-item"
    >
      <span
        aria-label="Drag attachment"
        title="Drag to reorder"
        className="cursor-grab p-2"
        role="img"
      >
        ⠿
      </span>
      <MediaThumb
        alt={String(node.alt ?? '')}
        assetId={String(node.assetId)}
        className="size-16 object-contain"
        video={video}
      />
      {onClearTags ? (
        <Button size="sm" variant="outline" onClick={onClearTags}>
          Remove X photo tags
        </Button>
      ) : null}
      {!video ? (
        <>
          <Button size="sm" variant="outline" onClick={onAlt}>
            {node.alt ? 'ALT' : '+ALT'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onFrame}
            disabled={node.mimeType === 'image/gif'}
          >
            Frame
          </Button>
          <Button asChild size="sm" variant="outline">
            <a
              href={`/?asset=${encodeURIComponent(String(node.assetId))}&fromDraft=${encodeURIComponent(draftId)}`}
              rel="noopener noreferrer"
              target="_blank"
            >
              Frame in Shots editor
            </a>
          </Button>
          {onTags ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onTags}
              disabled={node.mimeType === 'image/gif'}
            >
              Tag people
            </Button>
          ) : null}
        </>
      ) : null}
      <Button
        aria-label="Move attachment earlier"
        size="sm"
        variant="ghost"
        disabled={!onUp}
        onClick={onUp}
      >
        ↑
      </Button>
      <Button
        aria-label="Move attachment later"
        size="sm"
        variant="ghost"
        disabled={!onDown}
        onClick={onDown}
      >
        ↓
      </Button>
      <Select value={String(destination)} onValueChange={(value) => setDestination(Number(value))}>
        <SelectTrigger aria-label="Destination post" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Array.from({ length: postCount }, (_, index) => (
            <SelectItem value={String(index)} key={index}>
              Post {index + 1}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        disabled={destination === post}
        onClick={() => onMove(destination, false)}
      >
        Move
      </Button>
      <Button size="sm" variant="outline" onClick={() => onMove(destination, true)}>
        Copy
      </Button>
      <Button size="sm" variant="ghost" onClick={onRemove}>
        Remove
      </Button>
    </div>
  )
}
