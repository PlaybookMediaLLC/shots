'use client'

import * as React from 'react'
import confetti from 'canvas-confetti'
import { DownloadIcon as Download01Icon } from '@phosphor-icons/react/dist/ssr/Download'
import { FileZipIcon as FileZipIcon } from '@phosphor-icons/react/dist/ssr/FileZip'
import { StackIcon as Layers01Icon } from '@phosphor-icons/react/dist/ssr/Stack'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { ChoiceField, ToggleField } from '@/components/editor/inspector/fields'
import { Button } from '@/components/ui/button'
import {
  SaveToWorkspaceButton,
  UseInPostButton,
} from '@/components/workspace/SaveToWorkspaceButton'
import { useCanStartPost } from '@/lib/platform/can-start-post'
import { useExportProgress } from '@/hooks/useExportProgress'
import { trackExportComplete, trackExportError, trackExportStart } from '@/lib/analytics'
import { getAspectRatioPreset } from '@/lib/aspect-ratio-utils'
import { deliverFiles, exportStill, stillFormatSchema } from '@/lib/export/export-design'
import { frameRateFor, withCurrentCanvas } from '@/lib/export/export-settings'
import {
  animatedFormatSchema,
  FORMAT_INFO,
  formatHasControl,
  FRAME_RATES,
  GIF_WIDTHS,
  isAnimatedFormat,
  type OutputFormat,
  outputFormatSchema,
  type PdfCompression,
  type QualityPresetName,
} from '@/lib/export/formats'
import { useExportSettings } from '@/lib/export/use-export-settings'
import { designFileName, safeBaseName } from '@/lib/export/naming'
import { canvasTarget } from '@/lib/export/sizes'
import {
  exportAnimationVideo,
  exportSlideshowVideo,
  isExportAborted,
} from '@/lib/export-slideshow-video'
import { useImageStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { QualityPresetSelector } from './QualityPresetSelector'
import { ScaleSlider } from './ScaleSlider'
import { SizePicker } from './SizePicker'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'

const QUALITY_OPTIONS = [
  { label: 'High', value: 'high' },
  { label: 'Medium', value: 'medium' },
  { label: 'Low', value: 'low' },
] as const satisfies readonly { label: string; value: QualityPresetName }[]

const BITRATE_OPTIONS = [
  { label: 'High · 25 Mbps', value: 'high' },
  { label: 'Med · 10 Mbps', value: 'medium' },
  { label: 'Low · 5 Mbps', value: 'low' },
] as const satisfies readonly { label: string; value: QualityPresetName }[]

const COMPRESSION_OPTIONS = [
  { label: 'JPEG (smaller)', value: 'jpeg' },
  { label: 'Lossless', value: 'lossless' },
] as const satisfies readonly { label: string; value: PdfCompression }[]

const isAbort = (error: unknown) =>
  isExportAborted(error) || (error instanceof Error && error.name === 'AbortError')

/** One format button in the format grid. */
function FormatButton({
  format,
  onSelect,
  selected,
}: {
  format: OutputFormat
  onSelect: (format: OutputFormat) => void
  selected: boolean
}) {
  return (
    <Button
      variant="custom"
      size={null}
      aria-pressed={selected}
      className={cn(
        'h-8 cursor-pointer rounded-md border text-xs font-medium transition-colors',
        'outline-none focus-visible:ring-2 focus-visible:ring-foreground/25',
        selected
          ? 'border-foreground/20 bg-foreground/[0.1] text-foreground'
          : 'border-foreground/[0.08] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground'
      )}
      onClick={() => onSelect(format)}
      type="button"
    >
      {FORMAT_INFO[format].label}
    </Button>
  )
}

/** A short number field committed on blur or Enter, for durations. */
function SecondsField({
  label,
  max,
  min,
  onCommit,
  value,
}: {
  label: string
  max: number
  min: number
  onCommit: (seconds: number) => void
  value: number
}) {
  const [draft, setDraft] = React.useState(String(value))
  React.useEffect(() => setDraft(String(value)), [value])
  const id = React.useId()
  const commit = () => {
    const seconds = Number(draft)
    if (Number.isFinite(seconds) && seconds >= min && seconds <= max) onCommit(seconds)
    else setDraft(String(value))
  }
  return (
    <div className="flex items-center justify-between gap-2">
      <Label className="text-xs text-muted-foreground" htmlFor={id}>
        {label}
      </Label>
      <div className="flex items-center gap-1">
        <Input
          className="h-7 w-16 rounded-md border border-foreground/10 bg-transparent px-2 text-right text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-foreground/25"
          id={id}
          inputMode="decimal"
          max={max}
          min={min}
          onBlur={commit}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
          }}
          step={0.5}
          type="number"
          value={draft}
        />
        <span className="text-xs text-muted-foreground">s</span>
      </div>
    </div>
  )
}

/** Props of {@link ExportPanel}. */
export type ExportPanelProps = {
  /** Called after a file was downloaded, to close the menu. */
  onExported?: () => void
  /** Told when an export starts and ends, so the menu can stay open meanwhile. */
  onBusyChange?: (busy: boolean) => void
  /** Opens the batch workspace; the entry is shown only when given. */
  onOpenBatch?: () => void
  /**
   * Share items (F06): rendered under the export actions when given. This is
   * where the "Embed" snippet for a published share link belongs.
   */
  embed?: React.ReactNode
}

/**
 * The editor's export menu: every format (PNG, JPEG, WebP, SVG, PDF, GIF,
 * MP4, WebM), the settings that change the chosen format and no others,
 * several target sizes in one export (a ZIP, or one PDF page per size), and
 * the entry to batch mode.
 */
export function ExportPanel({ embed, onBusyChange, onExported, onOpenBatch }: ExportPanelProps) {
  const [settings, update] = useExportSettings()
  const canStartPost = useCanStartPost()
  const editor = useImageStore(
    useShallow((state) => ({
      customDimensions: state.customDimensions,
      imageName: state.imageName,
      selectedAspectRatio: state.selectedAspectRatio,
      slideCount: state.slides.length,
      slideDuration: state.slideshow.defaultDuration,
      slidesTotalSeconds: state.slides.reduce(
        (sum, slide) => sum + (slide.duration || state.slideshow.defaultDuration),
        0
      ),
      timelineDuration: state.timeline.duration,
      trackCount: state.timeline.tracks.length,
    }))
  )
  const videoProgress = useExportProgress()
  const [still, setStill] = React.useState<{ done: number; total: number } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const controller = React.useRef<AbortController | null>(null)

  const preset = React.useMemo(
    () => getAspectRatioPreset(editor.selectedAspectRatio),
    // customDimensions changes the 'custom' preset's size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editor.selectedAspectRatio, editor.customDimensions]
  )
  const canvas = preset
    ? { height: preset.height, width: preset.width }
    : { height: 1440, width: 1920 }
  const targets = withCurrentCanvas(settings.targets, canvas)
  const { format } = settings
  const info = FORMAT_INFO[format]
  const animated = isAnimatedFormat(format)
  const hasAnimation = editor.trackCount > 0
  const slides = !animated && editor.slideCount > 1 && settings.allSlides ? editor.slideCount : 1
  const fileCount = format === 'pdf' ? 1 : targets.length * slides
  const busy = still !== null || videoProgress.active
  const name = safeBaseName(editor.imageName ?? '')

  React.useEffect(() => onBusyChange?.(busy), [busy, onBusyChange])

  const exportStillFiles = async () => {
    const stillFormat = stillFormatSchema.parse(format)
    const abort = new AbortController()
    controller.current = abort
    setStill({ done: 0, total: targets.length * slides })
    const started = Date.now()
    trackExportStart(format, settings.quality, settings.scale)
    try {
      const files = await exportStill({
        allSlides: slides > 1,
        format: stillFormat,
        name,
        onProgress: (done, total) => setStill({ done, total }),
        pdfCompression: settings.pdfCompression,
        quality: settings.quality,
        scale: settings.scale,
        signal: abort.signal,
        targets,
        transparent: formatHasControl(format, 'transparency') && settings.transparent,
      })
      const downloaded = await deliverFiles(files, name)
      const bytes = files.reduce((sum, file) => sum + file.blob.size, 0)
      trackExportComplete(
        format,
        settings.quality,
        settings.scale,
        Math.round(bytes / 1024),
        Date.now() - started
      )
      return downloaded
    } finally {
      controller.current = null
      setStill(null)
    }
  }

  const videoOptions = () => {
    const animatedFormat = animatedFormatSchema.parse(format)
    return {
      fileName: designFileName(name, format),
      format: animatedFormat,
      fps: frameRateFor(animatedFormat, settings.fps),
      maxWidth: format === 'gif' && settings.gifWidth > 0 ? settings.gifWidth : undefined,
      quality: settings.quality,
    }
  }

  const exportVideo = async () => {
    const options = videoOptions()
    trackExportStart(format, settings.quality, 1)
    await (hasAnimation ? exportAnimationVideo(options) : exportSlideshowVideo(options))
    return options.fileName
  }

  const handleExport = async () => {
    setError(null)
    try {
      const downloaded = animated ? await exportVideo() : await exportStillFiles()
      confetti({ origin: { y: 0.6 }, particleCount: 100, spread: 70 })
      toast.success('Export ready', { description: `Saved as ${downloaded}` })
      onExported?.()
    } catch (exportError) {
      if (isAbort(exportError)) {
        toast('Export cancelled', { duration: 1500, id: 'export-cancelled' })
        return
      }
      const message =
        exportError instanceof Error ? exportError.message : 'Export failed. Please try again.'
      trackExportError(format, message)
      setError(message)
    }
  }

  const cancel = () => {
    controller.current?.abort()
    if (videoProgress.active) videoProgress.abort()
  }

  const createWorkspaceExport = async () => {
    if (animated) {
      let exported: Blob | undefined
      const options = {
        ...videoOptions(),
        onFile: (blob: Blob) => {
          exported = blob
        },
      }
      await (hasAnimation ? exportAnimationVideo(options) : exportSlideshowVideo(options))
      if (!exported) throw new Error('Nothing was exported.')
      return exported
    }
    const [file] = await exportStill({
      allSlides: false,
      format: stillFormatSchema.parse(format),
      name,
      pdfCompression: settings.pdfCompression,
      quality: settings.quality,
      scale: settings.scale,
      targets: [canvasTarget(canvas.width, canvas.height)],
      transparent: formatHasControl(format, 'transparency') && settings.transparent,
    })
    if (!file) throw new Error('Nothing was exported.')
    return file.blob
  }

  const progress = still
    ? Math.round((still.done / Math.max(1, still.total)) * 100)
    : Math.round(videoProgress.progress)
  const actionLabel = animated
    ? `Export as ${info.label}`
    : format === 'pdf'
      ? targets.length * slides > 1
        ? `Export PDF · ${targets.length * slides} pages`
        : 'Export as PDF'
      : fileCount > 1
        ? `Export ${fileCount} files (ZIP)`
        : `Export as ${info.label}`
  const durationSeconds = hasAnimation
    ? editor.timelineDuration / 1000
    : editor.slideCount > 1
      ? editor.slidesTotalSeconds
      : editor.slideDuration

  // The settings stay mounted while busy: a save in progress owns the export under way.
  const busyView = busy ? (
    <div className="space-y-3 p-5" aria-live="polite">
      <p className="text-ui-lg font-medium text-foreground">Exporting {info.label}…</p>
      <p className="text-xs text-muted-foreground">
        {still
          ? still.total > 1
            ? `Rendering ${Math.min(still.done + 1, still.total)} of ${still.total}`
            : 'Rendering your design'
          : 'Rendering every frame of the timeline'}
      </p>
      <div
        aria-label="Export progress"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={progress}
        className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]"
        role="progressbar"
      >
        <div
          className="h-full rounded-full bg-foreground transition-[width] duration-200"
          style={{ width: `${progress}%` }}
        />
      </div>
      <Button className="w-full" onClick={cancel} size="sm" variant="outline">
        Cancel
      </Button>
    </div>
  ) : null

  return (
    <>
      {busyView}
      <div
        className={cn(
          'max-h-[min(640px,calc(100vh-96px))] space-y-4 overflow-y-auto p-4',
          busy && 'hidden'
        )}
      >
        <div className="space-y-2">
          <span className="text-ui-lg font-medium text-foreground">Format</span>
          <div aria-label="Format" className="grid grid-cols-4 gap-1" role="group">
            {outputFormatSchema.options.map((option) => (
              <FormatButton
                format={option}
                key={option}
                onSelect={(next) => update({ format: next })}
                selected={option === format}
              />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{info.description}</p>
          {info.limitation ? (
            <p className="rounded-md bg-foreground/[0.04] p-2 text-[11px] leading-snug text-muted-foreground">
              {info.limitation}
            </p>
          ) : null}
        </div>

        {formatHasControl(format, 'sizes') ? (
          <SizePicker
            extra={[canvasTarget(canvas.width, canvas.height)]}
            onChange={(next) => update({ targets: next })}
            value={targets}
          />
        ) : null}

        {formatHasControl(format, 'quality') && (format === 'jpeg' || format === 'webp') ? (
          <QualityPresetSelector
            format={format}
            onQualityPresetChange={(quality) => update({ quality })}
            qualityPreset={settings.quality}
          />
        ) : null}
        {formatHasControl(format, 'quality') && animated ? (
          <ChoiceField
            label="Quality"
            onChange={(quality) => update({ quality })}
            options={BITRATE_OPTIONS}
            value={settings.quality}
          />
        ) : null}
        {formatHasControl(format, 'scale') ? (
          <ScaleSlider onScaleChange={(scale) => update({ scale })} scale={settings.scale} />
        ) : null}
        {format === 'pdf' ? (
          <>
            <ChoiceField
              label="Page image"
              onChange={(pdfCompression) => update({ pdfCompression })}
              options={COMPRESSION_OPTIONS}
              value={settings.pdfCompression}
            />
            {settings.pdfCompression === 'jpeg' ? (
              <ChoiceField
                label="JPEG quality"
                onChange={(quality) => update({ quality })}
                options={QUALITY_OPTIONS}
                value={settings.quality}
              />
            ) : null}
          </>
        ) : null}
        {formatHasControl(format, 'transparency') ? (
          <ToggleField
            checked={settings.transparent}
            label="Transparent background"
            onChange={(transparent) => update({ transparent })}
          />
        ) : null}
        {formatHasControl(format, 'fps') && animated ? (
          <ChoiceField
            label="Frame rate"
            onChange={(fps) => update({ fps: Number(fps) })}
            options={FRAME_RATES[format].map((fps) => ({
              label: `${fps} fps`,
              value: String(fps),
            }))}
            value={String(frameRateFor(format, settings.fps))}
          />
        ) : null}
        {formatHasControl(format, 'width') ? (
          <ChoiceField
            label="Width"
            onChange={(width) => update({ gifWidth: Number(width) })}
            options={GIF_WIDTHS.map((width) => ({
              label: width === 0 ? 'Canvas' : `${width}px`,
              value: String(width),
            }))}
            value={String(settings.gifWidth)}
          />
        ) : null}
        {formatHasControl(format, 'duration') ? (
          hasAnimation ? (
            <SecondsField
              label="Duration (timeline)"
              max={600}
              min={0.5}
              onCommit={(seconds) =>
                useImageStore.getState().setTimelineDuration(Math.round(seconds * 1000))
              }
              value={durationSeconds}
            />
          ) : editor.slideCount > 1 ? (
            <p className="text-xs text-muted-foreground">
              {editor.slideCount} slides · {durationSeconds.toFixed(1)}s in total
            </p>
          ) : (
            <SecondsField
              label="Length"
              max={60}
              min={0.5}
              onCommit={(seconds) =>
                useImageStore.getState().setSlideshow({ defaultDuration: seconds })
              }
              value={durationSeconds}
            />
          )
        ) : null}
        {animated && !hasAnimation ? (
          <p className="text-[11px] text-muted-foreground">
            {editor.slideCount > 1
              ? 'No motion yet: plays the slides in order.'
              : 'No motion yet: a still clip. Add an animation in the Motion tab.'}
          </p>
        ) : null}
        {!animated && editor.slideCount > 1 ? (
          <ToggleField
            checked={settings.allSlides}
            label={`All ${editor.slideCount} slides`}
            onChange={(allSlides) => update({ allSlides })}
          />
        ) : null}

        {error ? (
          <div
            className="rounded-md border border-destructive/20 bg-destructive/10 p-2.5 text-xs text-destructive"
            role="alert"
          >
            {error}
          </div>
        ) : null}

        <Button
          className="h-10 w-full rounded-md text-ui-lg font-semibold"
          disabled={!animated && targets.length === 0}
          onClick={handleExport}
        >
          {fileCount > 1 ? (
            <FileZipIcon className="mr-2" size={16} />
          ) : (
            <Download01Icon className="mr-2" size={16} />
          )}
          {actionLabel}
        </Button>

        {info.kind === 'raster' || animated ? (
          <>
            {canStartPost ? (
              <UseInPostButton
                createExport={createWorkspaceExport}
                mediaType={FORMAT_INFO[format].mime}
              />
            ) : null}
            <SaveToWorkspaceButton createExport={createWorkspaceExport} />
          </>
        ) : null}

        {embed}

        {onOpenBatch ? (
          <Button
            variant="custom"
            size={null}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-md border border-foreground/[0.08] p-2.5 text-left transition-colors hover:bg-foreground/[0.04]"
            onClick={onOpenBatch}
            type="button"
          >
            <Layers01Icon className="shrink-0 text-muted-foreground" size={16} />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-foreground">Batch export</span>
              <span className="block text-[11px] text-muted-foreground">
                Apply this design to many screenshots
              </span>
            </span>
          </Button>
        ) : null}
      </div>
    </>
  )
}
