'use client'

import * as React from 'react'
import { toast } from 'sonner'
import type { PlateEditor } from '@shots/platejs-editor/platejs/react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { call } from '@/lib/content-drafts/client'
import { assetContentUrl } from '@/lib/editor/services'
import { useTRPCClient } from '@/lib/trpc/react'
import { saveExportToWorkspace } from '@/lib/workspace/save-export'
import { coverCrop } from '@/lib/write/grid-layout'
import { attachmentEntry } from '@/lib/write/media-operations'

/** The shapes the destinations take, width over height. */
const SHAPES = [
  { label: 'Square 1:1', ratio: 1 },
  { label: 'Portrait 4:5', ratio: 4 / 5 },
  { label: 'Story 9:16', ratio: 9 / 16 },
  { label: 'Landscape 1.91:1', ratio: 1.91 },
  { label: 'Wide 16:9', ratio: 16 / 9 },
] as const

type Crop = { ratio: number; x: number; y: number }

/**
 * Crop an image to a shape. As a frame does, it saves a new image from the
 * original for this attachment; the original stays in the library, and a
 * frame on it is replaced.
 */
export function MediaCrop({
  editor,
  id,
  onClose,
}: {
  editor: PlateEditor
  id: string
  onClose: () => void
}) {
  const client = useTRPCClient()
  const [original] = React.useState(() => attachmentEntry(editor, id)?.[0])
  const [crop, setCrop] = React.useState<Crop>(
    () => (original?.cropSettings as Crop | undefined) ?? { ratio: 1, x: 0.5, y: 0.5 }
  )
  const [bitmap, setBitmap] = React.useState<ImageBitmap | null>(null)
  const [type, setType] = React.useState('image/png')
  const [busy, setBusy] = React.useState(false)
  const preview = React.useRef<HTMLCanvasElement>(null)
  const sourceId = String(original?.sourceAssetId ?? original?.assetId ?? '')
  // The parent passes a new onClose each render; loading the image must not repeat.
  const close = React.useRef(onClose)
  React.useEffect(() => {
    close.current = onClose
  })

  React.useEffect(() => {
    let image: ImageBitmap | undefined
    void (async () => {
      try {
        const response = await fetch(assetContentUrl(sourceId))
        if (!response.ok) throw new Error('The original image is unavailable.')
        const blob = await response.blob()
        if (blob.type === 'image/gif')
          throw new Error('Crop works on still images. A GIF keeps its animation uncropped.')
        image = await createImageBitmap(blob)
        setType(blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png')
        setBitmap(image)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'The image could not be opened.')
        close.current()
      }
    })()
    return () => image?.close()
  }, [sourceId])

  const rect = bitmap ? coverCrop(bitmap, { height: 1, width: crop.ratio }, crop) : null
  React.useEffect(() => {
    const canvas = preview.current
    if (!bitmap || !rect || !canvas) return
    const scale = Math.min(1, 320 / Math.max(rect.width, rect.height))
    canvas.width = Math.round(rect.width * scale)
    canvas.height = Math.round(rect.height * scale)
    canvas
      .getContext('2d')
      ?.drawImage(
        bitmap,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        0,
        0,
        canvas.width,
        canvas.height
      )
  }, [bitmap, rect])

  const apply = async () => {
    if (!bitmap || !rect) return
    setBusy(true)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(rect.width)
      canvas.height = Math.round(rect.height)
      canvas
        .getContext('2d')
        ?.drawImage(
          bitmap,
          rect.x,
          rect.y,
          rect.width,
          rect.height,
          0,
          0,
          canvas.width,
          canvas.height
        )
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (result) =>
            result ? resolve(result) : reject(new Error('The crop could not be drawn.')),
          type,
          0.92
        )
      )
      const saved = await saveExportToWorkspace({
        blob,
        fileName: type === 'image/jpeg' ? 'cropped-image.jpg' : 'cropped-image.png',
        classification: 'derived',
        parentAssetId: sourceId,
        trpcClient: client,
      })
      await call(`/api/v1/assets/${encodeURIComponent(saved.assetId)}/alt-text`, {
        method: 'PUT',
        body: { altText: String(original?.alt ?? '') },
      })
      const entry = attachmentEntry(editor, id)
      if (!entry || entry[0].assetId !== original?.assetId)
        throw new Error('This image changed while the crop was open. Reopen it to crop.')
      editor.tf.setNodes(
        {
          assetId: saved.assetId,
          url: assetContentUrl(saved.assetId),
          sourceAssetId: sourceId,
          cropSettings: crop,
          mimeType: type,
          width: canvas.width,
          height: canvas.height,
          processingStatus: 'ready',
        },
        { at: entry[1] }
      )
      editor.tf.unsetNodes('frameSettings', { at: entry[1] })
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The cropped image did not save.')
    } finally {
      setBusy(false)
    }
  }

  // Position applies along the side the shape does not fill.
  const free = {
    x: Boolean(bitmap && rect && rect.width < bitmap.width - 0.5),
    y: Boolean(bitmap && rect && rect.height < bitmap.height - 0.5),
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Crop image</DialogTitle>
          <DialogDescription>
            The original stays in your library. A new image is saved for this attachment, and a
            frame on it is replaced.
          </DialogDescription>
        </DialogHeader>
        <Select
          value={String(crop.ratio)}
          onValueChange={(value) => setCrop({ ...crop, ratio: Number(value) })}
        >
          <SelectTrigger aria-label="Crop shape">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SHAPES.map((shape) => (
              <SelectItem key={shape.label} value={String(shape.ratio)}>
                {shape.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {free.x ? (
          <Label className="grid gap-2">
            Horizontal position
            <Slider
              aria-label="Horizontal position"
              max={100}
              min={0}
              onValueChange={([x]) => setCrop({ ...crop, x: x / 100 })}
              value={[Math.round(crop.x * 100)]}
            />
          </Label>
        ) : null}
        {free.y ? (
          <Label className="grid gap-2">
            Vertical position
            <Slider
              aria-label="Vertical position"
              max={100}
              min={0}
              onValueChange={([y]) => setCrop({ ...crop, y: y / 100 })}
              value={[Math.round(crop.y * 100)]}
            />
          </Label>
        ) : null}
        <canvas
          aria-label="Cropped image preview"
          className="mx-auto max-h-80 max-w-full rounded border"
          data-testid="crop-preview"
          ref={preview}
          role="img"
        />
        <DialogFooter>
          <Button disabled={busy} onClick={onClose} variant="outline">
            Cancel
          </Button>
          <Button disabled={busy || !bitmap} onClick={() => void apply()}>
            Apply crop
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
