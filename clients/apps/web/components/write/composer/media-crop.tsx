'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
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
import { assetContentUrl } from '@/lib/editor/services'
import { decodeImage, processBitmap } from '@/lib/image-tools/ops'
import { DEFAULT_RESIZE, DEFAULT_REENCODE_QUALITY } from '@/lib/image-tools/plan'
import type { RasterFormat } from '@/lib/image-tools/types'
import { useTRPCClient } from '@/lib/trpc/react'
import { coverCrop } from '@/lib/write/grid-layout'
import { attachmentEntry } from '@/lib/write/media-operations'
import { applyDerivedImage } from './derived-image'

/** The shapes the destinations take, width over height. */
const SHAPES = [
  { label: 'Square 1:1', ratio: 1 },
  { label: 'Portrait 4:5', ratio: 4 / 5 },
  { label: 'Story 9:16', ratio: 9 / 16 },
  { label: 'Landscape 1.91:1', ratio: 1.91 },
  { label: 'Wide 16:9', ratio: 16 / 9 },
] as const

/** A crop as the attachment keeps it, so cropping again starts from the same place. */
const cropSchema = z.object({
  ratio: z.number().refine((ratio) => SHAPES.some((shape) => shape.ratio === ratio)),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
})
type Crop = z.infer<typeof cropSchema>

/**
 * The longest side a crop is saved at. Each destination's own size comes from
 * its derivative (limits.json maxEdge), so this only bounds memory and upload.
 */
const MAX_EDGE = 4096

/** Keep the source's format where a canvas can write it; anything else saves as PNG. */
const formatOf = (mime: string): RasterFormat =>
  mime === 'image/jpeg' ? 'jpeg' : mime === 'image/webp' ? 'webp' : 'png'

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
    () => cropSchema.safeParse(original?.cropSettings).data ?? { ratio: 1, x: 0.5, y: 0.5 }
  )
  const [bitmap, setBitmap] = React.useState<ImageBitmap | null>(null)
  const [format, setFormat] = React.useState<RasterFormat>('png')
  const [busy, setBusy] = React.useState(false)
  const preview = React.useRef<HTMLCanvasElement>(null)
  const sourceId = String(original?.sourceAssetId ?? original?.assetId ?? '')
  // The parent passes a new onClose each render; loading the image must not repeat.
  const close = React.useRef(onClose)
  React.useEffect(() => {
    close.current = onClose
  })

  React.useEffect(() => {
    const abort = new AbortController()
    let image: ImageBitmap | undefined
    void (async () => {
      try {
        const response = await fetch(assetContentUrl(sourceId), { signal: abort.signal })
        if (!response.ok) throw new Error('The original image is unavailable.')
        const blob = await response.blob()
        if (blob.type === 'image/gif')
          throw new Error('Crop works on still images. A GIF keeps its animation uncropped.')
        image = await decodeImage(blob)
        if (abort.signal.aborted) return image.close()
        setFormat(formatOf(blob.type))
        setBitmap(image)
      } catch (error) {
        if (abort.signal.aborted) return
        toast.error(error instanceof Error ? error.message : 'The image could not be opened.')
        close.current()
      }
    })()
    return () => {
      abort.abort()
      image?.close()
    }
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
      const result = await processBitmap(bitmap, {
        crop: rect,
        encode: { format, quality: DEFAULT_REENCODE_QUALITY },
        resize: { ...DEFAULT_RESIZE, height: MAX_EDGE, width: MAX_EDGE },
      })
      // A browser that cannot write WebP returns PNG; name and type follow the bytes.
      const mimeType = result.blob.type || 'image/png'
      await applyDerivedImage({
        alt: String(original?.alt ?? ''),
        blob: result.blob,
        client,
        editor,
        expectedAssetId: original?.assetId,
        fileName: `cropped-image.${mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1]}`,
        id,
        image: { height: result.height, mimeType, sourceAssetId: sourceId, width: result.width },
        settings: { cropSettings: crop },
      })
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
          disabled={busy}
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
              disabled={busy}
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
              disabled={busy}
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
