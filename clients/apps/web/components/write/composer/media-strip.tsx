'use client'

import { XIcon } from '@phosphor-icons/react/dist/ssr/X'
import { useQuery } from '@tanstack/react-query'
import * as React from 'react'
import { toast } from 'sonner'
import type { Value } from '@shots/platejs-editor/platejs'
import type { PlateEditor } from '@shots/platejs-editor/platejs/react'
import { postRanges } from '@/components/drafts/thread'
import { Button } from '@/components/ui/button'
import { FileDropZone } from '@/components/ui/file-drop-zone'
import { draftAssetNode, supportedDraftMedia } from '@/lib/platform/asset-handoff'
import { useTRPC, useTRPCClient } from '@/lib/trpc/react'
import type { DraftChannel } from '@/lib/write/document'
import { attachmentsIn, insertAttachments, removeAttachment } from '@/lib/write/media-operations'
import { DESTINATION_MEDIA, mediaProblems } from '@/lib/write/media-rules'
import { MediaThumb } from './media-thumb'

const RECENT_SHOWN = 6
const ACCEPT = {
  'image/gif': ['.gif'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'video/mp4': ['.mp4'],
  'video/quicktime': ['.mov'],
  'video/webm': ['.webm'],
}

/** What a platform takes, as people read it. */
function acceptsHint(channel: DraftChannel): string {
  const { images, video } = DESTINATION_MEDIA[channel]
  if (!images.length) return 'One video'
  return video ? 'Images or video' : 'Images'
}

/**
 * The post's media in one place: what is attached, with a way to remove it,
 * and everything needed to add more. Without an `editor` (a tab that follows
 * the main platform) it only shows what that platform publishes.
 */
export function MediaStrip({
  canEdit,
  channel,
  editor,
  onBrowse,
  onEditMain,
  onManage,
  value,
}: {
  canEdit: boolean
  channel: DraftChannel
  editor: PlateEditor | null
  onBrowse: () => void
  /** Go to the tab whose editor holds this media. */
  onEditMain?: () => void
  onManage: () => void
  value: Value
}) {
  const ranges = postRanges(value)
  const attachments = value.flatMap((node, index) =>
    attachmentsIn(node).map((attachment) => ({
      node: attachment,
      post: ranges.findIndex(([start, end]) => index >= start && index < end),
    }))
  )
  const editable = canEdit && editor
  return (
    <section
      aria-label="Media"
      className="mx-4 mb-3 grid gap-2"
      data-local-dropzone=""
      data-testid="media-strip"
    >
      {attachments.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-2">
          {attachments.map(({ node, post }, index) => {
            const video = node.type === 'video'
            const name = `${video ? 'Video' : 'Image'} ${index + 1}${
              ranges.length > 1 ? ` in post ${post + 1}` : ''
            }`
            return (
              <li
                className="relative"
                data-testid="media-strip-item"
                key={`${String(node.id ?? node.assetId)}-${index}`}
              >
                <MediaThumb
                  alt={name}
                  assetId={String(node.assetId)}
                  className="size-16 rounded-md border border-border"
                  video={video}
                />
                {editable ? (
                  <Button
                    aria-label={`Remove ${name}`}
                    className="absolute -top-1.5 -right-1.5 size-5 rounded-full p-0"
                    onClick={() => removeAttachment(editor, node)}
                    size={null}
                    title="Remove"
                    variant="secondary"
                  >
                    <XIcon aria-hidden className="size-3" />
                  </Button>
                ) : null}
              </li>
            )
          })}
          {editable ? (
            <li>
              <Button onClick={onManage} size="sm" variant="ghost">
                Manage
              </Button>
            </li>
          ) : null}
        </ul>
      ) : null}
      {editable ? (
        <AddMedia
          attached={attachments.map(({ node }) => String(node.assetId))}
          channel={channel}
          editor={editor}
          onBrowse={onBrowse}
        />
      ) : canEdit && onEditMain ? (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {attachments.length > 0 ? 'This media comes from the main platform.' : 'No media yet.'}
          <Button onClick={onEditMain} size="sm" variant="outline">
            Edit media on the main platform
          </Button>
        </p>
      ) : null}
    </section>
  )
}

function AddMedia({
  attached,
  channel,
  editor,
  onBrowse,
}: {
  attached: string[]
  channel: DraftChannel
  editor: PlateEditor
  onBrowse: () => void
}) {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const [attaching, setAttaching] = React.useState<string | null>(null)
  const recent = useQuery(
    trpc.asset.list.queryOptions({ limit: 24, sort: 'newest', type: 'all' }, { staleTime: 30_000 })
  )
  const offered = (recent.data?.assets ?? [])
    .filter(
      (asset) =>
        supportedDraftMedia(asset.mediaType) &&
        !attached.includes(asset.id) &&
        mediaProblems(channel, [{ mimeType: asset.mediaType }]).length === 0
    )
    .slice(0, RECENT_SHOWN)

  async function upload(files: File[]) {
    // The media plugin takes a FileList, as from a drop or a picker. It loads with the editor.
    const { PlaceholderPlugin } = await import('@shots/platejs-editor/@platejs/media/react')
    if (!editor.selection) editor.tf.select(editor.api.end([]))
    const list = new DataTransfer()
    files.forEach((file) => list.items.add(file))
    editor.getTransforms(PlaceholderPlugin).insert.media(list.files)
  }

  async function attach(asset: { id: string; mediaType: string }) {
    setAttaching(asset.id)
    try {
      // The asset may have been deleted since the list loaded; the server has the final word.
      await client.asset.signDownload.query({ assetId: asset.id })
      insertAttachments(editor, [draftAssetNode(asset)])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'This asset is no longer available.')
    } finally {
      setAttaching(null)
    }
  }

  return (
    <div className="grid gap-2">
      <FileDropZone
        accept={ACCEPT}
        hint={acceptsHint(channel)}
        label="Add media"
        multiple
        onFiles={(files) => {
          upload(files).catch((error: unknown) =>
            toast.error(error instanceof Error ? error.message : 'The media could not be added.')
          )
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        {recent.isError ? (
          <p className="text-xs text-muted-foreground" role="status">
            Recent media could not load.
          </p>
        ) : offered.length > 0 ? (
          <span className="text-xs text-muted-foreground">Recent</span>
        ) : null}
        {offered.map((asset) => (
          <Button
            aria-label={`Attach ${asset.fileName || 'recent media'}`}
            className="size-12 overflow-hidden rounded-md border border-border disabled:opacity-60"
            disabled={attaching !== null}
            key={asset.id}
            onClick={() => void attach(asset)}
            onMouseDown={(event) => event.preventDefault()}
            size={null}
            title={asset.fileName || undefined}
            type="button"
            variant="custom"
          >
            <MediaThumb
              assetId={asset.id}
              className="size-full"
              video={asset.mediaType.startsWith('video/')}
            />
          </Button>
        ))}
        <Button onClick={onBrowse} size="sm" type="button" variant="ghost">
          Browse library
        </Button>
      </div>
    </div>
  )
}
