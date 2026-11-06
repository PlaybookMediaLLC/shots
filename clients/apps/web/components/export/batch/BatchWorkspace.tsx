'use client'

import * as React from 'react'
import { WarningIcon as Alert02Icon } from '@phosphor-icons/react/dist/ssr/Warning'
import { CheckCircleIcon as CheckmarkCircle02Icon } from '@phosphor-icons/react/dist/ssr/CheckCircle'
import { TrashIcon as Delete02Icon } from '@phosphor-icons/react/dist/ssr/Trash'
import { ImageIcon as ImageUploadIcon } from '@phosphor-icons/react/dist/ssr/Image'
import { SpinnerGapIcon as Loading03Icon } from '@phosphor-icons/react/dist/ssr/SpinnerGap'
import { ArrowsClockwiseIcon as RefreshIcon } from '@phosphor-icons/react/dist/ssr/ArrowsClockwise'
import { toast } from 'sonner'
import { DocumentPreview } from '@/components/design/DocumentPreview'
import { ChoiceField, ToggleField } from '@/components/editor/inspector/fields'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import type { DesignDocument } from '@/lib/design/document'
import { exportDesignDocument } from '@/lib/design/export'
import { validateImageFile } from '@/lib/editor/import-images'
import { adaptDocumentToSize, documentCanvasSize } from '@/lib/export/adapt'
import {
  type BatchAdjustments,
  type BatchItemStatus,
  type BatchOutput,
  batchZipEntries,
  composeBatchItem,
  KEEP_WHOLE_STYLE,
  MAX_BATCH_ITEMS,
  renderBatch,
  runPool,
} from '@/lib/export/batch'
import { decodeScreenshot, renderBatchItem } from '@/lib/export/batch-export'
import {
  downloadBlob,
  imageAspectOf,
  type StillFormat,
  stillFormatSchema,
} from '@/lib/export/export-design'
import { withCurrentCanvas } from '@/lib/export/export-settings'
import { FORMAT_INFO, type PdfCompression, type QualityPresetName } from '@/lib/export/formats'
import { zipFileName } from '@/lib/export/naming'
import { canvasTarget, type ExportTarget } from '@/lib/export/sizes'
import { zipFiles } from '@/lib/export/zip'
import { hashString } from '@/lib/render/preview-cache'
import { cn } from '@/lib/utils'
import { ScaleSlider } from '../ScaleSlider'
import { SizePicker } from '../SizePicker'
import { Input } from '@/components/ui/input'
import { BatchPublishDialog } from './BatchPublishDialog'

/**
 * A style a batch can apply: the current design, a saved preset, or a brand
 * kit. Each is a DesignDocument; `composeBatchItem` puts any screenshot into it.
 */
export type BatchStyleSource = {
  /** Shown under the label in the style list. */
  description?: string
  document: DesignDocument
  id: string
  label: string
}

/** The id of the style taken from the editor when the workspace opens. */
const CURRENT_STYLE_ID = 'current-design'
/** Renders in flight: the render frame draws one at a time; a second keeps it busy meanwhile. */
const RENDER_CONCURRENCY = 2
/** Files decoded at once on import; each holds one full-size bitmap until its preview is made. */
const DECODE_CONCURRENCY = 3

type BatchItem = {
  /** Sizes rendered so far. */
  done: number
  error?: string
  height: number
  id: string
  name: string
  outputs?: BatchOutput[]
  /** Small JPEG proxy for thumbnails. */
  previewSrc: string
  /** The full-size screenshot, for exports. */
  src: string
  status: BatchItemStatus
  width: number
}

const FORMAT_OPTIONS = stillFormatSchema.options.map((format) => ({
  label: FORMAT_INFO[format].label,
  value: format,
}))
const QUALITY_OPTIONS = [
  { label: 'High', value: 'high' },
  { label: 'Medium', value: 'medium' },
  { label: 'Low', value: 'low' },
] as const satisfies readonly { label: string; value: QualityPresetName }[]
const COMPRESSION_OPTIONS = [
  { label: 'JPEG (smaller)', value: 'jpeg' },
  { label: 'Lossless', value: 'lossless' },
] as const satisfies readonly { label: string; value: PdfCompression }[]

const STATUS_LABELS: Record<BatchItemStatus, string> = {
  done: 'Done',
  failed: 'Failed',
  pending: 'Ready',
  rendering: 'Rendering',
}

function revoke(item: Pick<BatchItem, 'previewSrc' | 'src'>) {
  URL.revokeObjectURL(item.src)
  URL.revokeObjectURL(item.previewSrc)
}

/** One screenshot in the batch: its rendered thumbnail, status, and actions. */
function BatchItemCard({
  adjustments,
  item,
  locked,
  onRemove,
  onRetry,
  previewTarget,
  sizeCount,
  style,
  styleAspect,
}: {
  adjustments: BatchAdjustments
  item: BatchItem
  locked: boolean
  onRemove: () => void
  onRetry: () => void
  previewTarget: ExportTarget | undefined
  /** How many files the item renders, for its progress. */
  sizeCount: number
  style: DesignDocument
  styleAspect: number | undefined
}) {
  const aspect = item.width / item.height
  // The thumbnail is the item's own document, drawn by the stage, from the small proxy image.
  const preview = React.useMemo(() => {
    const document = composeBatchItem(
      style,
      { aspect, name: item.name, src: item.previewSrc },
      { adjustments, styleAspect }
    )
    return previewTarget
      ? adaptDocumentToSize(document, previewTarget, { imageAspect: aspect })
      : document
  }, [adjustments, aspect, item.name, item.previewSrc, previewTarget, style, styleAspect])
  const size = previewTarget ?? documentCanvasSize(style)

  return (
    <li className="group flex flex-col overflow-hidden rounded-md border border-foreground/[0.08] bg-foreground/[0.02]">
      <div
        className="relative bg-foreground/[0.04]"
        style={{ aspectRatio: `${size.width} / ${size.height}` }}
      >
        <DocumentPreview alt={`${item.name} with the batch style`} document={preview} />
        <span
          className={cn(
            'absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium',
            item.status === 'done' && 'bg-emerald-500/90 text-white',
            item.status === 'failed' && 'bg-destructive text-white',
            item.status === 'rendering' && 'bg-background/90 text-foreground',
            item.status === 'pending' && 'bg-background/80 text-muted-foreground'
          )}
        >
          {item.status === 'rendering' ? (
            <Loading03Icon className="animate-spin" size={10} />
          ) : null}
          {item.status === 'done' ? <CheckmarkCircle02Icon size={10} /> : null}
          {item.status === 'failed' ? <Alert02Icon size={10} /> : null}
          {STATUS_LABELS[item.status]}
          {item.status === 'rendering' ? ` ${item.done}/${sizeCount}` : null}
        </span>
      </div>
      <div className="flex min-w-0 items-start gap-1 p-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground" title={item.name}>
            {item.name}
          </p>
          <p className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {item.width}×{item.height}
          </p>
          {item.error ? (
            <p className="mt-1 text-[11px] leading-snug text-destructive" role="alert">
              {item.error}
            </p>
          ) : null}
        </div>
        {item.status === 'failed' ? (
          <Button variant="custom" size={null}
            aria-label={`Retry ${item.name}`}
            className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-40"
            disabled={locked}
            onClick={onRetry}
            type="button"
          >
            <RefreshIcon size={14} />
          </Button>
        ) : null}
        <Button variant="custom" size={null}
          aria-label={`Remove ${item.name}`}
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-destructive disabled:opacity-40"
          disabled={locked}
          onClick={onRemove}
          type="button"
        >
          <Delete02Icon size={14} />
        </Button>
      </div>
    </li>
  )
}

/** Props of {@link BatchWorkspace}. */
export type BatchWorkspaceProps = {
  onOpenChange: (open: boolean) => void
  open: boolean
  /**
   * More styles to offer after "Current design", such as saved presets (F03)
   * and brand kits (F02). Each is a full DesignDocument.
   */
  styleSources?: readonly BatchStyleSource[]
}

/**
 * Batch mode: import up to 50 screenshots, apply one style to all of them,
 * preview the results, adjust the batch, and export every size as a ZIP.
 * Renders run through the render frame a couple at a time, with progress,
 * per-item failures, retry, and cancel. Imports and results live here, not
 * in the design, and survive closing and reopening the workspace.
 */
export function BatchWorkspace({ onOpenChange, open, styleSources = [] }: BatchWorkspaceProps) {
  // The live design, snapshotted each time the workspace opens.
  const [current, setCurrent] = React.useState<DesignDocument | null>(null)
  React.useEffect(() => {
    if (open) setCurrent(exportDesignDocument({ keepLocalSources: true }))
  }, [open])
  const sources = React.useMemo<BatchStyleSource[]>(
    () => [
      ...(current
        ? [
            {
              description: 'The design in the editor',
              document: current,
              id: CURRENT_STYLE_ID,
              label: 'Current design',
            },
          ]
        : []),
      ...styleSources,
    ],
    [current, styleSources]
  )
  const [styleId, setStyleId] = React.useState(CURRENT_STYLE_ID)
  const style = sources.find((source) => source.id === styleId) ?? sources[0]
  const [styleAspect, setStyleAspect] = React.useState<number | undefined>()
  const styleSrc = style?.document.image.src
  React.useEffect(() => {
    let live = true
    void imageAspectOf(styleSrc).then((aspect) => {
      if (live) setStyleAspect(aspect)
    })
    return () => {
      live = false
    }
  }, [styleSrc])

  const designSize = style ? documentCanvasSize(style.document) : { height: 1440, width: 1920 }
  const [chosenTargets, setChosenTargets] = React.useState<ExportTarget[]>([
    canvasTarget(1920, 1440),
  ])
  const targets = withCurrentCanvas(chosenTargets, designSize)
  const [format, setFormat] = React.useState<StillFormat>('png')
  const [quality, setQuality] = React.useState<QualityPresetName>('high')
  const [scale, setScale] = React.useState(1)
  const [pdfCompression, setPdfCompression] = React.useState<PdfCompression>('jpeg')
  const [adjustments, setAdjustments] = React.useState<BatchAdjustments>(KEEP_WHOLE_STYLE)

  // Items live in a ref the async loops read and write, mirrored to state for rendering.
  const itemsRef = React.useRef<BatchItem[]>([])
  const [items, setItemsState] = React.useState<BatchItem[]>([])
  const setItems = React.useCallback((change: (items: BatchItem[]) => BatchItem[]) => {
    itemsRef.current = change(itemsRef.current)
    setItemsState(itemsRef.current)
  }, [])
  const updateItem = React.useCallback(
    (id: string, patch: Partial<BatchItem>) =>
      setItems((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item))),
    [setItems]
  )
  const [importing, setImporting] = React.useState<{ done: number; total: number } | null>(null)
  const [running, setRunning] = React.useState(false)
  const [confirmClear, setConfirmClear] = React.useState(false)
  const [publishing, setPublishing] = React.useState(false)
  /** Files the last import could not add, with the reason; shown until dismissed. */
  const [notAdded, setNotAdded] = React.useState<string[]>([])
  const controller = React.useRef<AbortController | null>(null)
  const fileInput = React.useRef<HTMLInputElement>(null)

  // Release every screenshot when the editor goes away.
  React.useEffect(
    () => () => {
      controller.current?.abort()
      itemsRef.current.forEach(revoke)
    },
    []
  )

  // Anything that changes how an item looks makes its rendered files stale.
  const outputKey = hashString(
    JSON.stringify([
      style?.document ?? null,
      styleAspect,
      targets,
      format,
      quality,
      scale,
      pdfCompression,
      adjustments,
    ])
  )
  React.useEffect(() => {
    setItems((list) =>
      list.map((item) =>
        item.status === 'done' || item.status === 'failed'
          ? { ...item, done: 0, error: undefined, outputs: undefined, status: 'pending' }
          : item
      )
    )
  }, [outputKey, setItems])

  const addFiles = async (files: readonly File[]) => {
    const rejected: string[] = []
    const room = MAX_BATCH_ITEMS - itemsRef.current.length
    const accepted = files.filter((file) => {
      const reason = validateImageFile(file)
      if (reason) rejected.push(`${file.name}: ${reason}`)
      return !reason
    })
    if (accepted.length > room) {
      rejected.push(`${accepted.length - room} more: a batch holds ${MAX_BATCH_ITEMS} screenshots.`)
      accepted.splice(room)
    }
    if (accepted.length > 0) {
      const decoded: (BatchItem | null)[] = new Array(accepted.length).fill(null)
      let finished = 0
      setImporting({ done: 0, total: accepted.length })
      await runPool(accepted, DECODE_CONCURRENCY, async (file, index) => {
        try {
          const { height, previewBlob, width } = await decodeScreenshot(file)
          decoded[index] = {
            done: 0,
            height,
            id: crypto.randomUUID(),
            name: file.name,
            previewSrc: URL.createObjectURL(previewBlob),
            src: URL.createObjectURL(file),
            status: 'pending',
            width,
          }
        } catch {
          rejected.push(`${file.name}: not a readable image.`)
        }
        setImporting({ done: ++finished, total: accepted.length })
      })
      setImporting(null)
      // Keep import order, whatever order the decodes finished in.
      setItems((list) => [...list, ...decoded.filter((item): item is BatchItem => item !== null)])
    }
    setNotAdded(rejected)
  }

  const settings = { format, pdfCompression, quality, scale, targets }

  /** Render the given items (default: every item not yet done). Resolves false when cancelled. */
  const render = async (ids?: readonly string[]): Promise<boolean> => {
    if (!style) return false
    const abort = new AbortController()
    controller.current = abort
    setRunning(true)
    const queue = itemsRef.current.filter((item) =>
      ids ? ids.includes(item.id) : item.status !== 'done'
    )
    const completed = await renderBatch(
      queue,
      (item, onSize, signal) => {
        const aspect = item.width / item.height
        const document = composeBatchItem(
          style.document,
          { aspect, name: item.name, src: item.src },
          { adjustments, styleAspect }
        )
        return renderBatchItem(document, aspect, settings, { onSize, signal })
      },
      updateItem,
      abort.signal,
      RENDER_CONCURRENCY
    )
    controller.current = null
    setRunning(false)
    return completed
  }

  const download = async () => {
    const entries = batchZipEntries(itemsRef.current, settings)
    if (entries.length === 0) return
    const name = zipFileName('screenshots', 'batch')
    downloadBlob(await zipFiles(entries), name)
    toast.success('Batch exported', { description: `Saved ${entries.length} files as ${name}` })
  }

  const exportAll = async () => {
    const completed = await render()
    if (!completed) {
      toast('Batch cancelled', {
        description: 'Finished screenshots are kept; export again to continue.',
      })
      return
    }
    const failed = itemsRef.current.filter((item) => item.status === 'failed').length
    if (failed > 0) {
      toast.error(`${failed} of ${itemsRef.current.length} screenshots failed`, {
        description: 'Retry them, or download the ones that finished.',
      })
      return
    }
    await download()
  }

  const removeItem = (id: string) => {
    const item = itemsRef.current.find((entry) => entry.id === id)
    if (item) revoke(item)
    setItems((list) => list.filter((entry) => entry.id !== id))
  }

  const clearAll = () => {
    itemsRef.current.forEach(revoke)
    setItems(() => [])
  }

  // Rendered screenshots as posts: the first size of each, since a post
  // carries one image, and the batch page keeps each item's file name.
  const publishExports = React.useMemo(
    () =>
      items.flatMap((item) => {
        const output = item.outputs?.[0]
        return output ? [{ blob: output.blob, name: item.name }] : []
      }),
    [items]
  )

  const total = items.length
  const done = items.filter((item) => item.status === 'done').length
  const failed = items.filter((item) => item.status === 'failed').length
  const remaining = total - done
  const locked = running || importing !== null
  const fileCount = format === 'pdf' ? total : total * targets.length

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault()
    if (!locked) void addFiles(Array.from(event.dataTransfer.files))
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="flex h-[min(880px,92vh)] max-w-[calc(100%-2rem)] flex-col gap-0 p-0 sm:max-w-6xl"
        data-local-dropzone
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files).filter((file) =>
            file.type.startsWith('image/')
          )
          if (files.length > 0 && !locked) {
            event.preventDefault()
            void addFiles(files)
          }
        }}
      >
        <header className="border-b border-foreground/[0.08] px-5 py-4 pr-12">
          <DialogTitle>Batch export</DialogTitle>
          <DialogDescription className="mt-1 text-xs">
            Apply one design to up to {MAX_BATCH_ITEMS} screenshots and export every size as one
            ZIP.
          </DialogDescription>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[300px_1fr]">
          <aside
            aria-label="Batch settings"
            className="space-y-5 overflow-y-auto border-foreground/[0.08] p-4 md:border-r"
          >
            <fieldset className="space-y-2" disabled={locked}>
              <legend className="text-ui-lg font-medium text-foreground">Style</legend>
              {sources.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Open a design in the editor to use it as the style.
                </p>
              ) : (
                <div aria-label="Style" className="space-y-1.5" role="radiogroup">
                  {sources.map((source) => (
                    <Button variant="custom" size={null}
                      aria-checked={source.id === style?.id}
                      className={cn(
                        'flex w-full cursor-pointer items-center gap-2.5 rounded-md border p-1.5 text-left transition-colors',
                        source.id === style?.id
                          ? 'border-foreground/25 bg-foreground/[0.06]'
                          : 'border-foreground/[0.08] hover:bg-foreground/[0.04]'
                      )}
                      key={source.id}
                      onClick={() => setStyleId(source.id)}
                      role="radio"
                      type="button"
                    >
                      <span className="h-10 w-14 shrink-0 overflow-hidden rounded bg-foreground/[0.05]">
                        <DocumentPreview alt="" document={source.document} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-foreground">
                          {source.label}
                        </span>
                        {source.description ? (
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {source.description}
                          </span>
                        ) : null}
                      </span>
                    </Button>
                  ))}
                </div>
              )}
            </fieldset>

            <fieldset className="space-y-4" disabled={locked}>
              <SizePicker
                extra={[canvasTarget(designSize.width, designSize.height)]}
                onChange={setChosenTargets}
                value={targets}
              />
              <ChoiceField
                label="Format"
                onChange={(next) => setFormat(stillFormatSchema.parse(next))}
                options={FORMAT_OPTIONS}
                value={format}
              />
              {FORMAT_INFO[format].limitation ? (
                <p className="text-[11px] leading-snug text-muted-foreground">
                  {FORMAT_INFO[format].limitation}
                </p>
              ) : null}
              {format === 'jpeg' ||
              format === 'webp' ||
              (format === 'pdf' && pdfCompression === 'jpeg') ? (
                <ChoiceField
                  label="Quality"
                  onChange={setQuality}
                  options={QUALITY_OPTIONS}
                  value={quality}
                />
              ) : null}
              {format === 'pdf' ? (
                <ChoiceField
                  label="Page image"
                  onChange={setPdfCompression}
                  options={COMPRESSION_OPTIONS}
                  value={pdfCompression}
                />
              ) : null}
              {format !== 'svg' ? <ScaleSlider onScaleChange={setScale} scale={scale} /> : null}
            </fieldset>

            <fieldset className="space-y-2.5" disabled={locked}>
              <legend className="pb-1 text-ui-lg font-medium text-foreground">
                Apply to every screenshot
              </legend>
              <ToggleField
                checked={adjustments.background}
                label="Background"
                onChange={(background) => setAdjustments((value) => ({ ...value, background }))}
              />
              <ToggleField
                checked={adjustments.frame}
                label="Window frame"
                onChange={(frame) => setAdjustments((value) => ({ ...value, frame }))}
              />
              <ToggleField
                checked={adjustments.text}
                label="Text"
                onChange={(text) => setAdjustments((value) => ({ ...value, text }))}
              />
              <ToggleField
                checked={adjustments.markup}
                label="Markup and blur"
                onChange={(markup) => setAdjustments((value) => ({ ...value, markup }))}
              />
            </fieldset>
          </aside>

          <section aria-label="Screenshots" className="flex min-h-0 flex-col">
            <Input
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                event.target.value = ''
                void addFiles(files)
              }}
              ref={fileInput}
              type="file"
            />
            {notAdded.length > 0 ? (
              <div
                className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/10 p-2.5 text-xs text-destructive"
                role="alert"
              >
                <Alert02Icon className="mt-0.5 shrink-0" size={14} />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {notAdded.length === 1 ? 'One file was' : `${notAdded.length} files were`} not
                    added
                  </p>
                  <ul className="mt-0.5 space-y-0.5">
                    {notAdded.slice(0, 5).map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                    {notAdded.length > 5 ? <li>and {notAdded.length - 5} more</li> : null}
                  </ul>
                </div>
                <Button variant="custom" size={null}
                  className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 hover:bg-destructive/10"
                  onClick={() => setNotAdded([])}
                  type="button"
                >
                  Dismiss
                </Button>
              </div>
            ) : null}
            {total === 0 ? (
              <div className="grid flex-1 place-items-center p-6" data-batch-dropzone>
                <Button variant="custom" size={null}
                  className="flex w-full max-w-md cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-foreground/20 p-10 text-center transition-colors hover:bg-foreground/[0.03] disabled:cursor-progress"
                  disabled={locked}
                  onClick={() => fileInput.current?.click()}
                  type="button"
                >
                  <ImageUploadIcon className="text-muted-foreground" size={28} />
                  <span className="text-ui-lg font-medium text-foreground">
                    {importing
                      ? `Importing ${importing.done} of ${importing.total}…`
                      : 'Add screenshots'}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Drop, paste, or browse: PNG, JPEG, or WebP, up to {MAX_BATCH_ITEMS}
                  </span>
                </Button>
              </div>
            ) : (
              <>
                <div
                  className="flex items-center gap-2 border-b border-foreground/[0.08] px-4 py-2.5"
                  data-batch-dropzone
                >
                  <Button
                    disabled={locked || total >= MAX_BATCH_ITEMS}
                    onClick={() => fileInput.current?.click()}
                    size="sm"
                    variant="outline"
                  >
                    <ImageUploadIcon className="mr-1.5" size={14} />
                    Add screenshots
                  </Button>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {importing
                      ? `Importing ${importing.done} of ${importing.total}…`
                      : `${total} of ${MAX_BATCH_ITEMS}`}
                  </span>
                  <Button variant="custom" size={null}
                    className="ml-auto cursor-pointer rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-foreground/[0.06] hover:text-destructive disabled:opacity-40"
                    disabled={locked}
                    onClick={() => setConfirmClear(true)}
                    type="button"
                  >
                    Clear all
                  </Button>
                </div>
                <ul
                  aria-label="Batch screenshots"
                  className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3 overflow-y-auto p-4"
                >
                  {items.map((item) =>
                    style ? (
                      <BatchItemCard
                        adjustments={adjustments}
                        item={item}
                        key={item.id}
                        locked={locked}
                        onRemove={() => removeItem(item.id)}
                        onRetry={() => void render([item.id])}
                        previewTarget={targets[0]}
                        sizeCount={targets.length}
                        style={style.document}
                        styleAspect={styleAspect}
                      />
                    ) : null
                  )}
                </ul>
              </>
            )}
          </section>
        </div>

        <footer className="flex flex-wrap items-center gap-3 border-t border-foreground/[0.08] px-5 py-3">
          <div className="min-w-0 flex-1" aria-live="polite">
            {running ? (
              <>
                <p className="text-xs text-foreground">
                  Rendered {done} of {total}
                  {failed > 0 ? ` · ${failed} failed` : ''}
                </p>
                <div
                  aria-label="Batch progress"
                  aria-valuemax={total}
                  aria-valuemin={0}
                  aria-valuenow={done}
                  className="mt-1.5 h-1.5 max-w-sm overflow-hidden rounded-full bg-foreground/[0.08]"
                  role="progressbar"
                >
                  <div
                    className="h-full rounded-full bg-foreground transition-[width] duration-200"
                    style={{ width: `${total ? (done / total) * 100 : 0}%` }}
                  />
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                {total === 0
                  ? 'No screenshots yet.'
                  : `${total} screenshot${total === 1 ? '' : 's'} × ${targets.length} size${targets.length === 1 ? '' : 's'} → ${fileCount} file${fileCount === 1 ? '' : 's'}`}
                {failed > 0 ? ` · ${failed} failed` : ''}
              </p>
            )}
          </div>
          {running ? (
            <Button onClick={() => controller.current?.abort()} size="sm" variant="outline">
              Cancel
            </Button>
          ) : null}
          {!running && done > 0 && remaining > 0 ? (
            <Button onClick={() => void download()} size="sm" variant="outline">
              Download {done} finished
            </Button>
          ) : null}
          {!running && publishExports.length > 0 ? (
            <Button onClick={() => setPublishing(true)} size="sm" variant="outline">
              Create {publishExports.length} post{publishExports.length === 1 ? '' : 's'}
            </Button>
          ) : null}
          <Button
            disabled={locked || total === 0 || targets.length === 0 || !style}
            onClick={() => void (remaining > 0 ? exportAll() : download())}
            size="sm"
          >
            {running ? 'Rendering…' : remaining > 0 ? `Export ${total} as ZIP` : 'Download ZIP'}
          </Button>
        </footer>

        {publishing ? (
          <BatchPublishDialog
            exports={publishExports}
            onOpenChange={setPublishing}
            open={publishing}
            sizes={format === 'pdf' ? 1 : targets.length}
          />
        ) : null}

        <AlertDialog onOpenChange={setConfirmClear} open={confirmClear}>
          <AlertDialogContent className="sm:max-w-[400px]">
            <AlertDialogHeader>
              <AlertDialogTitle>Remove every screenshot?</AlertDialogTitle>
              <AlertDialogDescription>
                The {total} screenshots and their rendered files leave this batch. Your design is
                not changed.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep them</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={clearAll}
              >
                Remove all
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}
