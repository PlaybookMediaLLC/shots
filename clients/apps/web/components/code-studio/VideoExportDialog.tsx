'use client'

import * as React from 'react'
import { PauseIcon } from '@phosphor-icons/react/dist/ssr/Pause'
import { PlayIcon } from '@phosphor-icons/react/dist/ssr/Play'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FileDropZone } from '@/components/ui/file-drop-zone'
import { Label } from '@/components/ui/label'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { trackEvent } from '@/lib/analytics'
import type { CodeDocument } from '@/lib/code-studio/document'
import { documentSize } from '@/lib/code-studio/layout'
import { videoDuration } from '@/lib/code-studio/timeline'
import { isAudioEncodingSupported } from '@/lib/export/audio-track'
import { FFmpegVideoEncoder } from '@/lib/export/ffmpeg-encoder'
import {
  isAlphaWebmSupported,
  isWebCodecsSupported,
  WebCodecsVideoEncoder,
} from '@/lib/export/webcodecs-encoder'
import { AnimatedScene } from './AnimatedScene'
import { prehighlight, type SceneCapture } from './capture'

/** A video's container. */
export type VideoFormat = 'mp4' | 'webm' | 'gif'
/** The shorter side of the video, in pixels. */
export type VideoResolution = 720 | 1080 | 2160

/** What a video export needs. */
export type VideoRequest = {
  format: VideoFormat
  resolution: VideoResolution
  transparent?: boolean
  voiceOver?: File | null
  onProgress?: (progress: number) => void
}

const even = (value: number) => Math.round(value / 2) * 2

/** A voice-over decoded and fitted to the video's length, silent where it is shorter. */
async function fittedAudio(file: File, seconds: number): Promise<AudioBuffer> {
  const decoder = new AudioContext()
  try {
    const decoded = await decoder.decodeAudioData(await file.arrayBuffer())
    const offline = new OfflineAudioContext(
      decoded.numberOfChannels,
      Math.ceil(seconds * decoded.sampleRate),
      decoded.sampleRate
    )
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    return await offline.startRendering()
  } finally {
    void decoder.close()
  }
}

/**
 * Render a code project to video in the browser (RFC 053): each frame is the
 * animated scene at its time, captured and encoded with WebCodecs (MP4, WebM)
 * or FFmpeg (GIF). Nothing is sent to a server.
 */
export function useVideoRenderer(document: CodeDocument, capture: SceneCapture, logoUrl?: string) {
  const supported = isWebCodecsSupported()
  const render = React.useCallback(
    async ({ format, resolution, transparent = false, voiceOver, onProgress }: VideoRequest) => {
      const base = documentSize(document, { caption: true })
      const gif = format === 'gif'
      const shorter = gif ? Math.min(resolution, 720) : resolution
      const scale = shorter / Math.min(base.width, base.height)
      const width = even(base.width * scale)
      const height = even(base.height * scale)
      const fps = gif ? 15 : 30
      const duration = videoDuration(document)
      const count = Math.max(1, Math.ceil((duration / 1000) * fps))
      const audio = voiceOver && !gif ? await fittedAudio(voiceOver, duration / 1000) : null
      if (audio && !(await isAudioEncodingSupported(format === 'webm' ? 'webm' : 'mp4', audio)))
        throw new Error(
          'This browser cannot encode the voice-over. Try Chrome or Edge, or remove it.'
        )
      const times = Array.from({ length: count }, (_, index) => (index * 1000) / fps)
      const props = { document, size: base, logoUrl }
      try {
        if (gif) {
          const encoder = new FFmpegVideoEncoder({
            width,
            height,
            fps,
            format: 'gif',
            quality: 'medium',
          })
          try {
            await encoder.initialize()
            await capture.frames(props, times, scale, async (canvas, index) => {
              await encoder.addFrame(canvas)
              onProgress?.((index + 1) / count)
            })
            return await encoder.encode()
          } catch (error) {
            await encoder.dispose()
            throw error
          }
        }
        const encoder = new WebCodecsVideoEncoder({
          width,
          height,
          fps,
          container: format,
          bitrate: resolution >= 2160 ? 40_000_000 : resolution >= 1080 ? 12_000_000 : 6_000_000,
          audio,
          alpha: format === 'webm' && transparent,
        })
        try {
          await encoder.initialize()
          await capture.frames(props, times, scale, async (canvas, index) => {
            await encoder.encodeFromCanvas(canvas, index)
            onProgress?.((index + 1) / count)
          })
          return await encoder.finalize()
        } catch (error) {
          encoder.dispose()
          throw error
        }
      } finally {
        capture.done()
      }
    },
    [document, capture, logoUrl]
  )
  const mp4 = React.useCallback(
    (onProgress: (progress: number) => void) =>
      render({ format: 'mp4', resolution: 1080, onProgress }),
    [render]
  )
  return { supported, render, mp4 }
}

/** What {@link useVideoRenderer} returns. */
export type VideoRenderer = ReturnType<typeof useVideoRenderer>

/** A live preview of the video, playing the same frames the export captures. */
function Preview({ document }: { document: CodeDocument }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [width, setWidth] = React.useState(0)
  const [time, setTime] = React.useState(0)
  const [playing, setPlaying] = React.useState(false)
  const [, ready] = React.useReducer((count: number) => count + 1, 0)
  const duration = videoDuration(document)
  // Morphs read highlighted tokens synchronously, as the export does.
  React.useEffect(() => {
    void prehighlight(document).then(ready, () => undefined)
  }, [document])
  const size = documentSize(document, { caption: true })
  React.useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  React.useEffect(() => {
    if (!playing) return
    let frame = 0
    const started = performance.now() - time
    const tick = (now: number) => {
      const next = now - started
      if (next >= duration) {
        setTime(duration)
        setPlaying(false)
        return
      }
      setTime(next)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
    // Restart only when play is pressed; `time` is the starting point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, duration])
  const scale = width ? Math.min(width / size.width, 320 / size.height) : 0
  return (
    <div className="space-y-2">
      <div ref={ref} className="flex justify-center overflow-hidden rounded-md bg-muted/50">
        <div style={{ width: size.width * scale, height: size.height * scale }}>
          {scale ? (
            <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
              <AnimatedScene document={document} time={time} size={size} />
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={() => {
            if (!playing && time >= duration) setTime(0)
            setPlaying(!playing)
          }}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <Slider
          aria-label="Position"
          min={0}
          max={duration}
          step={10}
          value={[time]}
          valueDisplay={`${(time / 1000).toFixed(1)} / ${(duration / 1000).toFixed(1)} s`}
          onValueChange={([value]) => {
            setPlaying(false)
            setTime(value!)
          }}
        />
      </div>
    </div>
  )
}

/** Props of {@link VideoExportDialog}. */
export type VideoExportDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  document: CodeDocument
  name: string
  renderer: VideoRenderer
}

/** Preview the slides as a video and export it as MP4, WebM or GIF. */
export function VideoExportDialog({
  open,
  onOpenChange,
  document,
  name,
  renderer,
}: VideoExportDialogProps) {
  const id = React.useId()
  const [format, setFormat] = React.useState<VideoFormat>('mp4')
  const [resolution, setResolution] = React.useState<VideoResolution>(1080)
  const [transparent, setTransparent] = React.useState(false)
  const [voiceOver, setVoiceOver] = React.useState<File | null>(null)
  const [progress, setProgress] = React.useState<number | null>(null)
  const [alphaOk, setAlphaOk] = React.useState(false)
  const [uhdOk, setUhdOk] = React.useState(false)
  const size = documentSize(document, { caption: true })
  React.useEffect(() => {
    if (!open) return
    void isAlphaWebmSupported(size.width, size.height, 30).then(setAlphaOk)
    void (async () => {
      if (typeof VideoEncoder === 'undefined') return setUhdOk(false)
      const scale = 2160 / Math.min(size.width, size.height)
      const result = await VideoEncoder.isConfigSupported({
        codec: 'avc1.640033',
        width: even(size.width * scale),
        height: even(size.height * scale),
        bitrate: 40_000_000,
        framerate: 30,
      }).catch(() => ({ supported: false }))
      setUhdOk(!!result.supported)
    })()
  }, [open, size.width, size.height])

  const exportVideo = async () => {
    setProgress(0)
    try {
      const blob = await renderer.render({
        format,
        resolution: resolution === 2160 && !uhdOk ? 1080 : resolution,
        transparent: format === 'webm' && transparent,
        voiceOver,
        onProgress: setProgress,
      })
      const url = URL.createObjectURL(blob)
      const link = window.document.createElement('a')
      link.href = url
      link.download = `${name}.${format}`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1_000)
      trackEvent('code_studio_export', {
        kind: `video-${format}`,
        resolution,
        slides: document.slides.length,
      })
      onOpenChange(false)
    } catch (failure) {
      toast.error('The video could not be exported', {
        description:
          failure instanceof Error ? failure.message : 'Try a smaller size or another format.',
      })
    } finally {
      setProgress(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => progress === null && onOpenChange(next)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Export video</DialogTitle>
          <DialogDescription>
            Each slide is a step. Set each slide&apos;s transition, timing and caption in the Slide
            settings; the video renders in this browser.
          </DialogDescription>
        </DialogHeader>
        {open ? <Preview document={document} /> : null}
        {!renderer.supported ? (
          <p role="alert" className="text-sm text-destructive">
            This browser cannot encode video. Use a recent Chrome, Edge or Safari.
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Format</Label>
            <SegmentedControl
              ariaLabel="Format"
              size="sm"
              value={format}
              onChange={(value) => setFormat(value as VideoFormat)}
              options={[
                { id: 'mp4', label: 'MP4' },
                { id: 'webm', label: 'WebM' },
                { id: 'gif', label: 'GIF' },
              ]}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Resolution</Label>
            <SegmentedControl
              ariaLabel="Resolution"
              size="sm"
              value={String(resolution)}
              onChange={(value) => setResolution(Number(value) as VideoResolution)}
              options={[
                { id: '720', label: '720p' },
                { id: '1080', label: '1080p' },
                ...(uhdOk && format !== 'gif' ? [{ id: '2160', label: '4K' }] : []),
              ]}
            />
          </div>
        </div>
        {format === 'webm' ? (
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={`${id}-alpha`} className="font-normal">
              Transparent background
            </Label>
            <Switch
              id={`${id}-alpha`}
              checked={transparent && alphaOk}
              disabled={!alphaOk || document.style.showBackground}
              onCheckedChange={setTransparent}
            />
          </div>
        ) : null}
        {format === 'webm' && (!alphaOk || document.style.showBackground) ? (
          <p className="text-xs text-muted-foreground">
            {alphaOk
              ? 'Turn the background off in Look to export with transparency.'
              : 'This browser cannot encode transparent video.'}
          </p>
        ) : null}
        {format !== 'gif' ? (
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-voice`}>Voice-over (optional)</Label>
            <FileDropZone
              id={`${id}-voice`}
              accept={{ 'audio/*': [] }}
              disabled={progress !== null}
              hint="An audio file, trimmed or padded to the video's length. It stays in this browser."
              label="Voice-over"
              onFiles={([file]) => setVoiceOver(file ?? null)}
              onRemove={() => setVoiceOver(null)}
              preview={
                voiceOver ? <span className="truncate text-sm">{voiceOver.name}</span> : undefined
              }
            />
          </div>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={progress !== null}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button disabled={!renderer.supported || progress !== null} onClick={exportVideo}>
            {progress === null ? 'Export' : `Rendering… ${Math.round(progress * 100)}%`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
