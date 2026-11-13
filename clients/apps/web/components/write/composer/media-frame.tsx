'use client'

import * as React from 'react'
import { toast } from 'sonner'
import type { PlateEditor } from '@shots/platejs-editor/platejs/react'
import { Button } from '@/components/ui/button'
import { SwatchColorPicker } from '@/components/ui/color-picker'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { designDocumentSchema, DESIGN_DOCUMENT_VERSION } from '@/lib/design/document'
import { brandKitDefinitionSchema } from '@/lib/tenant/schemas'
import { renderDocument } from '@/lib/render/scene-renderer'
import { call } from '@/lib/content-drafts/client'
import { assetContentUrl } from '@/lib/editor/services'
import { useTRPCClient } from '@/lib/trpc/react'
import { saveExportToWorkspace } from '@/lib/workspace/save-export'
import { attachmentEntry } from '@/lib/write/media-operations'

type Frame = { color: string; padding: number; radius: number }

/** Frames use the same Shots stage and upload pipeline as design exports. */
export function MediaFrame({
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
  const [settings, setSettings] = React.useState<Frame>(
    () =>
      (original?.frameSettings as Frame | undefined) ?? {
        color: '#6366f1',
        padding: 32,
        radius: 12,
      }
  )
  const [palette, setPalette] = React.useState<string[]>([])
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<{
    blob: Blob
    url: string
    width: number
    height: number
    settings: string
  } | null>(null)
  React.useEffect(() => {
    void client.brandKit.list.query().then(
      ({ brandKits }) =>
        setPalette([
          ...new Set(
            brandKits.flatMap((kit) => {
              const parsed = brandKitDefinitionSchema.safeParse(kit.definition)
              return parsed.success ? Object.values(parsed.data.colors) : []
            })
          ),
        ]),
      () => {}
    )
  }, [client])
  React.useEffect(
    () => () => {
      if (result) URL.revokeObjectURL(result.url)
    },
    [result]
  )
  const sourceId = String(original?.sourceAssetId ?? original?.assetId ?? '')
  const render = async () => {
    setBusy(true)
    let source: string | undefined
    try {
      const response = await fetch(assetContentUrl(sourceId))
      if (!response.ok) throw new Error('The original image is unavailable.')
      const blob = await response.blob()
      if (blob.type === 'image/gif')
        throw new Error(
          'Frames currently support static images. GIFs keep their animation without a frame.'
        )
      source = URL.createObjectURL(blob)
      const picture = new Image()
      picture.src = source
      await picture.decode()
      const scale = Math.min(1, 2048 / Math.max(picture.naturalWidth, picture.naturalHeight))
      const document = designDocumentSchema.parse({
        version: DESIGN_DOCUMENT_VERSION,
        canvas: {
          aspectRatio: 'custom',
          padding: settings.padding,
          size: {
            width: Math.round(picture.naturalWidth * scale) + settings.padding * 2,
            height: Math.round(picture.naturalHeight * scale) + settings.padding * 2,
          },
        },
        background: { type: 'solid', value: settings.color, opacity: 1, blur: 0, noise: 0 },
        image: { src: source, radius: settings.radius },
      })
      const capture = await renderDocument(document, { format: 'png', scale: 1, strict: true })
      setResult({
        ...capture,
        url: URL.createObjectURL(capture.blob),
        settings: JSON.stringify(settings),
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The frame could not be rendered.')
    } finally {
      if (source) URL.revokeObjectURL(source)
      setBusy(false)
    }
  }
  const apply = async () => {
    if (!result || result.settings !== JSON.stringify(settings)) return
    setBusy(true)
    try {
      const saved = await saveExportToWorkspace({
        blob: result.blob,
        fileName: 'framed-image.png',
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
        throw new Error(
          'This image changed while the frame editor was open. Reopen it to apply a frame.'
        )
      editor.tf.setNodes(
        {
          assetId: saved.assetId,
          url: assetContentUrl(saved.assetId),
          sourceAssetId: sourceId,
          frameSettings: settings,
          mimeType: 'image/png',
          width: result.width,
          height: result.height,
          processingStatus: 'ready',
        },
        { at: entry[1] }
      )
      // A frame starts from the original, so an earlier crop no longer applies.
      editor.tf.unsetNodes('cropSettings', { at: entry[1] })
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The framed image did not save.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Frame image</DialogTitle>
          <DialogDescription>
            Beta: the original remains in your library. A new image is saved for this attachment.
          </DialogDescription>
        </DialogHeader>
        <Label>
          Frame color{' '}
          <SwatchColorPicker
            aria-label="Frame color"
            value={settings.color}
            onChange={(color) => setSettings({ ...settings, color })}
            swatches={palette}
          />
        </Label>
        {palette.length ? (
          <div className="flex gap-2" aria-label="Brand colors">
            {palette.map((color) => (
              <Button
                variant="custom"
                size={null}
                key={color}
                type="button"
                aria-label={`Use brand color ${color}`}
                style={{ background: color }}
                className="size-7 rounded border"
                onClick={() => setSettings({ ...settings, color })}
              />
            ))}
          </div>
        ) : null}
        <Label>
          Padding{' '}
          <Slider
            aria-label="Frame padding"
            min={0}
            max={100}
            value={[settings.padding]}
            onValueChange={([padding]) => setSettings({ ...settings, padding })}
          />
        </Label>
        <Label>
          Corner radius{' '}
          <Slider
            aria-label="Corner radius"
            min={0}
            max={100}
            value={[settings.radius]}
            onValueChange={([radius]) => setSettings({ ...settings, radius })}
          />
        </Label>
        {result ? (
          <img
            alt="Framed image preview"
            src={result.url}
            className="max-h-80 w-full object-contain"
          />
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void render()}>
            Preview frame
          </Button>
          <Button
            disabled={busy || !result || result.settings !== JSON.stringify(settings)}
            onClick={() => void apply()}
          >
            Apply frame
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
