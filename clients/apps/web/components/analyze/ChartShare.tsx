'use client'

import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { SwatchColorPicker } from '@/components/ui/color-picker'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Slider } from '@/components/ui/slider'
import { designDocumentSchema, type DesignDocument } from '@/lib/design/document'
import { designCatalog, type FrameType } from '@/lib/design/catalog'
import { useDocumentPreview } from '@/lib/render/use-document-preview'
import { renderDocument } from '@/lib/render/scene-renderer'
import { downloadBlob } from '@/lib/export/export-design'

const OUTPUT = { format: 'png' as const, scale: 1, quality: 'high' as const }

/** The chart is a source image in the existing Shots design document and renderer. */
export function ChartShare({
  source,
  name,
  onClose,
}: {
  source: string
  name: string
  onClose: () => void
}) {
  const [crop, setCrop] = React.useState('landscape')
  const [color, setColor] = React.useState('#0f172a')
  const [gradient, setGradient] = React.useState('')
  const [frame, setFrame] = React.useState<FrameType>('none')
  const [inset, setInset] = React.useState(60)
  const [radius, setRadius] = React.useState(16)
  const [rotation, setRotation] = React.useState(0)
  const [zoom, setZoom] = React.useState(100)
  const [shadow, setShadow] = React.useState<DesignDocument['image']['shadow']>({ preset: 'soft' })
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const document = React.useMemo(
    () =>
      designDocumentSchema.parse({
        version: 2,
        canvas: {
          aspectRatio: 'custom',
          size: {
            width: 1200,
            height: crop === 'square' ? 1200 : crop === 'portrait' ? 1500 : 750,
          },
          padding: inset,
        },
        background: { type: gradient ? 'gradient' : 'solid', value: gradient || color },
        mode: 'screenshot',
        image: {
          src: source,
          name,
          scale: zoom,
          radius,
          rotation,
          shadow,
          frame: { type: frame, color, padding: frame === 'none' ? 0 : 12 },
        },
      }),
    [source, name, crop, inset, gradient, color, zoom, radius, rotation, shadow, frame]
  )
  const preview = useDocumentPreview(document, OUTPUT)
  const create = async () => {
    setBusy(true)
    setError('')
    try {
      const output = await renderDocument(document, OUTPUT)
      downloadBlob(output.blob, `${name.replace(/[^a-z0-9_-]/gi, '-').slice(0, 100)}.png`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="max-h-[95vh] overflow-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Create chart image</DialogTitle>
          <DialogDescription>
            {name}. The image includes the selected account, metric, period, and observation cutoff.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Label>
            Crop{' '}
            <NativeSelect
              aria-label="Image crop"
              value={crop}
              onChange={(e) => setCrop(e.target.value)}
            >
              <NativeSelectOption value="landscape">Landscape</NativeSelectOption>
              <NativeSelectOption value="square">Square</NativeSelectOption>
              <NativeSelectOption value="portrait">Portrait</NativeSelectOption>
            </NativeSelect>
          </Label>
          <Label>
            Color{' '}
            <SwatchColorPicker
              aria-label="Image color"
              value={color}
              onChange={setColor}
            />
          </Label>
          <Label>
            Frame{' '}
            <NativeSelect
              aria-label="Image frame"
              value={frame}
              onChange={(e) => setFrame(e.target.value as FrameType)}
            >
              {designCatalog.frames.map((f) => (
                <NativeSelectOption value={f} key={f}>
                  {f}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Label>
          <Label>
            Gradient{' '}
            <NativeSelect
              aria-label="Image gradient"
              value={gradient}
              onChange={(e) => setGradient(e.target.value)}
            >
              <NativeSelectOption value="">Solid color</NativeSelectOption>
              {designCatalog.gradients.map((g) => (
                <NativeSelectOption key={g}>{g}</NativeSelectOption>
              ))}
            </NativeSelect>
          </Label>
          {[
            { label: 'Inset', value: inset, max: 200, min: 0, set: setInset },
            { label: 'Corner radius', value: radius, max: 100, min: 0, set: setRadius },
            { label: 'Rotation', value: rotation, min: -180, max: 180, set: setRotation },
            { label: 'Crop zoom', value: zoom, min: 10, max: 200, set: setZoom },
          ].map((control) => (
            <Label key={control.label} className="grid gap-1.5">
              {control.label}: {control.value}
              <Slider
                className="block w-full"
                aria-label={control.label}
                min={control.min}
                max={control.max}
                value={[control.value]}
                onValueChange={([value]) => control.set(value)}
              />
            </Label>
          ))}
          <Label>
            Shadow{' '}
            <NativeSelect
              aria-label="Image shadow"
              value={shadow?.preset}
              onChange={(e) =>
                setShadow({ preset: e.target.value as 'none' | 'hug' | 'soft' | 'strong' })
              }
            >
              {designCatalog.shadowPresets.map((s) => (
                <NativeSelectOption key={s}>{s}</NativeSelectOption>
              ))}
            </NativeSelect>
          </Label>
        </div>
        <div className="min-h-48 rounded border bg-muted p-2">
          {preview.url ? (
            <img
              alt={`${name} image preview`}
              src={preview.url}
              className="mx-auto max-h-96 max-w-full"
            />
          ) : null}
          {preview.status === 'rendering' ? <p role="status">Rendering preview…</p> : null}
          {preview.status === 'error' ? (
            <p role="alert">
              Preview could not render. Change a control or try Create image again.
            </p>
          ) : null}
        </div>
        {error ? <p role="alert">{error}</p> : null}
        <Button disabled={busy} onClick={() => void create()}>
          {busy ? 'Creating image…' : 'Create image'}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
