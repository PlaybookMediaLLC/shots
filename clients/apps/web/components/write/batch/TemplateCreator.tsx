'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Pill, Row, Section } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  type BatchGrid,
  type BatchItem,
  type BatchItemInput,
  BATCH_ITEM_LIMIT,
  type OverlayPosition,
  TEMPLATE_SHAPES,
  UGC_CLIP_MS,
  UGC_CLOSING_MS,
} from '@/lib/api/contracts/content-batches'
import { assetContentUrl } from '@/lib/editor/services'
import { useTRPCClient } from '@/lib/trpc/react'
import { safeAssetFileName, saveExportToWorkspace } from '@/lib/workspace/save-export'
import { captureVideoFrame } from '@/lib/workspace/video-poster'
import { readAudioFile } from '@/lib/write/audio-trim'
import { clipLengthProblem, gridReady } from '@/lib/write/grid-concepts'
import { GRID_VIDEO, ugcTimeline } from '@/lib/write/grid-layout'
import { composeStill, drawOverlay } from '@/lib/write/grid-render'
import { CaptionAssistant } from './CaptionAssistant'
import { FilePicker } from './FilePicker'
import { AUDIO_ACCEPT } from './GridCreator'
import { MusicTrim } from './MusicTrim'
import { Segmented } from './Segmented'
import type { ConceptRenderer } from './use-concept-render'

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const CLIP_ACCEPT = 'video/mp4,video/quicktime,.mp4,.mov'

/** The type a clip uploads as: some systems give a .mov or .mp4 no type at all. */
function clipType(file: File) {
  if (file.type === 'video/mp4' || file.type === 'video/quicktime') return file.type
  const extension = file.name.toLowerCase().split('.').pop()
  return extension === 'mp4' ? 'video/mp4' : extension === 'mov' ? 'video/quicktime' : null
}

/** A template's name and what the page says about it. */
const COPY = {
  single: {
    description:
      'One image fades in under a headline for six seconds, at 1080×1920, with optional music. Each one becomes a post of this batch.',
    file: 'fade-in-video',
    title: 'Fade-in videos',
  },
  ugc: {
    description:
      'Your own clip with text over it, an optional closing clip of 3 to 15 seconds after it, and optional music, at 1080×1920. Each one becomes a post of this batch.',
    file: 'ugc-video',
    title: 'UGC videos',
  },
} as const

type Kind = keyof typeof COPY
type Saved = BatchItem & { grid: BatchGrid }

/** The post's caption a video's text seeds: one line. */
const captionOf = (text: string) => text.replace(/\s+/g, ' ').trim()

/** Previews draw the export's frame at a quarter of its size: what they show, for a fraction of the memory. */
const PREVIEW = { height: GRID_VIDEO.height / 4, scale: 0.25, width: GRID_VIDEO.width / 4 }

/**
 * A clip asset's length, read from its metadata, for the music trim and the
 * summary. `onError` must be stable, such as a state setter.
 */
function useClipLength(assetId: string | undefined, onError: (message: string) => void) {
  const [length, setLength] = React.useState<number | null>(null)
  React.useEffect(() => {
    setLength(null)
    if (!assetId) return
    const video = document.createElement('video')
    video.preload = 'metadata'
    const release = () => {
      video.removeAttribute('src')
      video.load()
    }
    video.addEventListener(
      'loadedmetadata',
      () => {
        setLength(video.duration * 1000)
        release()
      },
      { once: true }
    )
    video.addEventListener(
      'error',
      () => onError('This browser cannot read the clip. Use an H.264 MP4 or MOV.'),
      { once: true }
    )
    video.src = assetContentUrl(assetId)
    return release
  }, [assetId, onError])
  return length
}

/** The fade-in's frame as it renders: the same drawing as the export, redrawn only when what it shows changes. */
function StillPreview({ grid, name }: { grid: BatchGrid; name: string }) {
  const canvas = React.useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = React.useState(false)
  const { headline, hideHeadline, kind } = grid
  const image = grid.slots[0]?.assetId
  React.useEffect(() => {
    let live = true
    setFailed(false)
    void composeStill({
      headline,
      hideHeadline,
      kind,
      slots: [{ assetId: image, topic: '' }],
    }).then(
      (still) => {
        if (live)
          canvas.current?.getContext('2d')?.drawImage(still, 0, 0, PREVIEW.width, PREVIEW.height)
      },
      () => live && setFailed(true)
    )
    return () => {
      live = false
    }
  }, [headline, hideHeadline, image, kind])
  return (
    <div className="grid gap-1">
      <canvas
        ref={canvas}
        aria-label={`Preview of ${name}`}
        className="aspect-[9/16] w-full rounded-lg bg-black"
        height={PREVIEW.height}
        role="img"
        width={PREVIEW.width}
      />
      {failed ? (
        <p role="alert" className="text-xs text-destructive">
          The preview could not be drawn: the image did not load.
        </p>
      ) : null}
    </div>
  )
}

/** The UGC video as it renders: the clip, covering the frame, under its text. */
function UgcPreview({
  clipId,
  name,
  position,
  text,
}: {
  clipId?: string
  name: string
  position: OverlayPosition
  text: string
}) {
  const canvas = React.useRef<HTMLCanvasElement>(null)
  const video = React.useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = React.useState(false)
  React.useEffect(() => {
    const context = canvas.current?.getContext('2d')
    if (!context) return
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, PREVIEW.width, PREVIEW.height)
    context.setTransform(PREVIEW.scale, 0, 0, PREVIEW.scale, 0, 0)
    drawOverlay(context, text, position)
  }, [position, text])
  return (
    <div className="grid gap-2">
      <div className="relative aspect-[9/16] w-full overflow-hidden rounded-lg bg-black">
        {clipId ? (
          // Plays only when asked: a page of previews would otherwise decode every clip at once.
          // Its control sits below it, so nothing covers text at the bottom.
          <video
            ref={video}
            aria-label={`Preview of ${name}`}
            className="absolute inset-0 size-full object-cover"
            loop
            muted
            playsInline
            preload="metadata"
            src={assetContentUrl(clipId)}
            onPause={() => setPlaying(false)}
            onPlay={() => setPlaying(true)}
          />
        ) : (
          <span className="absolute inset-x-0 top-4 text-center text-xs text-white/70">
            No clip
          </span>
        )}
        <canvas
          ref={canvas}
          aria-hidden
          className="pointer-events-none absolute inset-0 size-full"
          height={PREVIEW.height}
          width={PREVIEW.width}
        />
      </div>
      {clipId ? (
        <Button
          aria-label={`${playing ? 'Pause' : 'Play'} preview of ${name}`}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => {
            const element = video.current
            if (!element) return
            if (element.paused)
              void element.play().catch(() => toast.error('This browser could not play the clip.'))
            else element.pause()
          }}
        >
          {playing ? 'Pause' : 'Play'}
        </Button>
      ) : null}
    </div>
  )
}

/** One video: its preview, its media and text, and its music. */
function ConceptCard({
  disabled,
  index,
  item,
  kind,
  onUpdate,
  status,
  upload,
}: {
  disabled: boolean
  index: number
  item: Saved
  kind: Kind
  onUpdate: (grid: (latest: BatchGrid) => BatchGrid) => Promise<unknown>
  status: React.ReactNode
  upload: (file: File) => Promise<string>
}) {
  const { grid } = item
  const name = `video ${index + 1}`
  const [text, setText] = React.useState(grid.headline)
  React.useEffect(() => setText(grid.headline), [grid.headline])
  // Turning image only off with no headline waits for one before it saves.
  const [captionOn, setCaptionOn] = React.useState(false)
  const imageOnly = Boolean(grid.hideHeadline) && !captionOn
  const [busy, setBusy] = React.useState('')
  const [problem, setProblem] = React.useState('')
  const clipMs = useClipLength(kind === 'ugc' ? grid.slots[0]?.assetId : undefined, setProblem)
  const closingMs = useClipLength(grid.closingAssetId, setProblem)
  const videoMs =
    kind === 'single'
      ? GRID_VIDEO.seconds * 1000
      : clipMs === null || (grid.closingAssetId && closingMs === null)
        ? null
        : ugcTimeline(clipMs, closingMs ?? 0).durationMs

  /** An upload or change, with what went wrong said beside it. */
  const attempt = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label)
    setProblem('')
    try {
      await work()
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'That did not work. Try again.')
    } finally {
      setBusy('')
    }
  }
  const saveText = (next: string) => {
    const headline = kind === 'ugc' ? next.trim() : captionOf(next)
    if (headline === grid.headline && !captionOn) return
    if (!headline && !imageOnly) {
      setText(grid.headline)
      setProblem(
        kind === 'single'
          ? 'A video needs its headline. Choose image only to leave it out.'
          : 'A video needs its text.'
      )
      return
    }
    void attempt('', async () => {
      await onUpdate(({ hideHeadline: _was, ...latest }) => ({
        ...latest,
        headline,
        ...(imageOnly ? { hideHeadline: true } : {}),
      }))
      setCaptionOn(false)
    })
  }
  const setImageOnly = (on: boolean) => {
    if (!on && !grid.headline.trim()) {
      setCaptionOn(true)
      return
    }
    setCaptionOn(false)
    void attempt('', () =>
      onUpdate(({ hideHeadline: _was, ...latest }) => ({
        ...latest,
        ...(on ? { hideHeadline: true } : {}),
      }))
    )
  }
  // One change at a time: a second upload finishing first would be overwritten by the first.
  const locked = disabled || Boolean(busy)
  const media = grid.slots[0]?.assetId
  const chooseImage = (file: File | undefined) => {
    if (!file) return
    if (!IMAGE_TYPES.includes(file.type)) {
      setProblem('Choose a JPEG, PNG or WebP image.')
      return
    }
    void attempt('Uploading the image…', async () => {
      const assetId = await upload(file)
      await onUpdate((latest) => ({ ...latest, slots: [{ assetId, topic: '' }] }))
    })
  }
  const chooseClip = (file: File | undefined, closing: boolean) => {
    if (!file) return
    const type = clipType(file)
    if (!type) {
      setProblem('Choose an MP4 or MOV video.')
      return
    }
    void attempt(closing ? 'Uploading the closing clip…' : 'Uploading the clip…', async () => {
      // Read as the renderer will: no picture (a codec this browser lacks) is refused too.
      const frame = await captureVideoFrame(file)
      if (!frame || frame.durationMs === null)
        throw new Error('This browser cannot show the clip. Use an H.264 MP4 or MOV.')
      const length = frame.durationMs
      const wrong = closing
        ? clipLengthProblem(length, UGC_CLOSING_MS, 'The closing clip')
        : clipLengthProblem(length, UGC_CLIP_MS, 'The clip')
      if (wrong) throw new Error(wrong)
      const assetId = await upload(new File([file], file.name, { type }))
      await onUpdate((latest) =>
        closing
          ? { ...latest, closingAssetId: assetId }
          : { ...latest, slots: [{ assetId, topic: '' }] }
      )
    })
  }
  const chooseMusic = (file: File | undefined) => {
    if (!file) return
    void attempt('Uploading music…', async () => {
      const type = await readAudioFile(file)
      const musicAssetId = await upload(new File([file], file.name, { type }))
      await onUpdate(({ musicStartMs: _start, ...latest }) => ({ ...latest, musicAssetId }))
    })
  }

  return (
    <li
      className="grid gap-4 rounded-2xl border border-border p-4 sm:grid-cols-[160px_minmax(0,1fr)]"
      data-testid="template-concept"
    >
      <div className="w-40 justify-self-center sm:justify-self-start">
        {kind === 'single' ? (
          <StillPreview grid={grid} name={name} />
        ) : (
          <UgcPreview
            clipId={media}
            name={name}
            position={grid.textPosition ?? 'middle'}
            text={text}
          />
        )}
      </div>
      <div className="grid content-start gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">Video {index + 1}</span>
          {status}
        </div>
        {kind === 'single' ? (
          <>
            <Label className="grid gap-1.5 font-normal">
              Headline for {name}
              <Input
                disabled={disabled || imageOnly}
                maxLength={TEMPLATE_SHAPES.single.text}
                placeholder={imageOnly ? 'Caption disabled' : undefined}
                value={text}
                onBlur={(event) => saveText(event.target.value)}
                onChange={(event) => setText(event.target.value)}
              />
            </Label>
            <Label className="flex items-center gap-2 font-normal">
              <Switch
                aria-label={`No caption (image only) for ${name}`}
                checked={imageOnly}
                disabled={disabled}
                onCheckedChange={setImageOnly}
              />
              No caption (image only)
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              <FilePicker
                accept={IMAGE_TYPES.join(',')}
                disabled={locked}
                label={`Image for ${name}`}
                onFiles={([file]) => chooseImage(file)}
              >
                {media ? 'Replace image' : 'Upload image'}
              </FilePicker>
            </div>
          </>
        ) : (
          <>
            <Label className="grid gap-1.5 font-normal">
              Text for {name}
              <Textarea
                disabled={disabled}
                maxLength={TEMPLATE_SHAPES.ugc.text}
                rows={3}
                value={text}
                onBlur={(event) => saveText(event.target.value)}
                onChange={(event) => setText(event.target.value)}
              />
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                disabled={locked}
                label={`Text position for ${name}`}
                options={[
                  ['top', 'Top'],
                  ['middle', 'Middle'],
                  ['bottom', 'Bottom'],
                ]}
                value={grid.textPosition ?? 'middle'}
                onChange={(textPosition: OverlayPosition) =>
                  void attempt('', () => onUpdate((latest) => ({ ...latest, textPosition })))
                }
              />
              <CaptionAssistant
                disabled={locked}
                label={`text for ${name}`}
                onChoose={(choice) => {
                  setText(choice)
                  saveText(choice)
                }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <FilePicker
                accept={CLIP_ACCEPT}
                disabled={locked}
                label={`Clip for ${name}`}
                onFiles={([file]) => chooseClip(file, false)}
              >
                {media ? 'Replace clip' : 'Choose clip'}
              </FilePicker>
              <FilePicker
                accept={CLIP_ACCEPT}
                disabled={locked}
                label={`Closing clip for ${name}`}
                onFiles={([file]) => chooseClip(file, true)}
              >
                {grid.closingAssetId ? 'Replace closing clip' : 'Add closing clip'}
              </FilePicker>
              {grid.closingAssetId ? (
                <Button
                  disabled={locked}
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    void attempt('', () =>
                      onUpdate(({ closingAssetId: _gone, ...latest }) => latest)
                    )
                  }
                >
                  Remove closing clip
                </Button>
              ) : null}
              <span className="text-xs text-muted-foreground">
                {clipMs !== null ? `Clip ${(clipMs / 1000).toFixed(1)} s` : null}
                {closingMs !== null ? ` · closing clip ${(closingMs / 1000).toFixed(1)} s` : null}
              </span>
            </div>
          </>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <FilePicker
            accept={AUDIO_ACCEPT}
            disabled={locked}
            label={`Music for ${name}`}
            onFiles={([file]) => chooseMusic(file)}
          >
            {grid.musicAssetId ? 'Change music' : 'Add music'}
          </FilePicker>
          {grid.musicAssetId && videoMs !== null ? (
            <MusicTrim
              key={`${grid.musicAssetId}/${videoMs}`}
              assetId={grid.musicAssetId}
              disabled={locked}
              label={`music for ${name}`}
              startMs={grid.musicStartMs ?? 0}
              videoMs={videoMs}
              onSave={(musicStartMs) => onUpdate((latest) => ({ ...latest, musicStartMs }))}
            />
          ) : null}
          {grid.musicAssetId ? (
            <Button
              disabled={locked}
              size="sm"
              type="button"
              variant="ghost"
              onClick={() =>
                void attempt('', () =>
                  onUpdate(({ musicAssetId: _gone, musicStartMs: _start, ...latest }) => latest)
                )
              }
            >
              Remove music
            </Button>
          ) : null}
        </div>
        {busy ? (
          <p role="status" className="text-xs text-muted-foreground">
            {busy}
          </p>
        ) : null}
        {problem ? (
          <p role="alert" className="text-xs text-destructive">
            {problem}
          </p>
        ) : null}
      </div>
    </li>
  )
}

/**
 * Fade-in or UGC videos. Each video is a batch item, so a fresh tab comes back
 * to it, and each finished video is saved on its item at once: closing the tab
 * loses only the video being rendered. From then on it is an ordinary post.
 */
export function TemplateCreator({
  disabled,
  items,
  kind,
  onAdd,
  onUpdate,
  renderer,
  sharedAccounts,
}: {
  disabled: boolean
  items: BatchItem[]
  kind: Kind
  onAdd: (inputs: BatchItemInput[]) => Promise<void>
  onUpdate: (
    item: BatchItem,
    body: (latest: BatchItem) => Record<string, unknown>
  ) => Promise<unknown>
  /** The batch's one renderer, shared with the other creators. */
  renderer: ConceptRenderer
  sharedAccounts: string[]
}) {
  const trpc = useTRPCClient()
  const { download, downloadAll, progress, render, running, stop } = renderer
  const copy = COPY[kind]
  const ours = (item: BatchItem): item is Saved => item.grid?.kind === kind
  const concepts = items.filter((item): item is Saved => ours(item) && !item.draftId)
  // A saved draft's video can still be downloaded, though its concept no longer changes.
  const finished = items.filter(
    (item): item is Saved => ours(item) && item.media.some((entry) => entry.assetId)
  )
  const toRender = concepts.filter(
    (item) => gridReady(item.grid) && !item.media.some((entry) => entry.assetId)
  )

  const [text, setText] = React.useState('')
  const [imageOnly, setImageOnly] = React.useState(false)
  const [adding, setAdding] = React.useState(false)
  const add = async () => {
    if (items.length >= BATCH_ITEM_LIMIT) {
      toast.error(`A batch holds up to ${BATCH_ITEM_LIMIT} posts.`)
      return
    }
    const headline = kind === 'ugc' ? text.trim() : captionOf(text)
    const grid: BatchGrid =
      kind === 'single'
        ? { headline, kind, slots: [{ topic: '' }], ...(imageOnly ? { hideHeadline: true } : {}) }
        : { headline, kind, slots: [{ topic: '' }], textPosition: 'middle' }
    setAdding(true)
    try {
      await onAdd([
        {
          caption: captionOf(headline),
          channelConnectionIds: sharedAccounts,
          grid,
          importKey: `${kind}-${crypto.randomUUID()}`,
          media: [],
          timing: {},
        },
      ])
      setText('')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The video could not be added.')
    } finally {
      setAdding(false)
    }
  }

  const upload = async (file: File) => {
    const { assetId } = await saveExportToWorkspace({
      blob: file,
      fileName: safeAssetFileName(file.name) || `${copy.file}-file`,
      trpcClient: trpc,
    })
    return assetId
  }
  // A caption still equal to the video's text follows it, as a grid's follows its headline.
  // The batch reports a failed save itself and answers false; the card then keeps its state.
  const update = async (item: Saved, change: (latest: BatchGrid) => BatchGrid) => {
    const saved = await onUpdate(item, (latest) => {
      const before = latest.grid ?? item.grid
      const grid = change(before)
      return {
        grid,
        ...(latest.caption === captionOf(before.headline)
          ? { caption: captionOf(grid.headline) }
          : {}),
      }
    })
    if (saved === false) throw new Error('The change was not saved. Try again.')
  }

  const status = (item: Saved) => {
    const state = progress[item.id]
    if (item.media.some((entry) => entry.assetId))
      return (
        <>
          <Pill tone="green">Done</Pill>
          <Button
            aria-label={`Download video ${concepts.indexOf(item) + 1}`}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => void download(item)}
          >
            Download
          </Button>
        </>
      )
    if (typeof state === 'string')
      return (
        <span role="alert" className="text-xs text-destructive">
          {state}
        </span>
      )
    if (typeof state === 'number')
      return (
        <span role="status" className="text-xs text-muted-foreground tabular-nums">
          Rendering {Math.round(state * 100)}%
        </span>
      )
    return gridReady(item.grid) ? (
      <Pill tone="gray">Ready to render</Pill>
    ) : (
      <Pill tone="gray">{kind === 'single' ? 'Needs an image' : 'Needs a clip'}</Pill>
    )
  }

  return (
    <Section title={copy.title} description={copy.description}>
      <Row
        layout="stacked"
        label="New video"
        description={
          kind === 'single'
            ? 'The headline above the image. The post’s caption starts as the same text.'
            : 'The text over the clip; a line break starts a new line. The post’s caption starts as the same text.'
        }
      >
        <div className="grid w-full gap-2">
          {kind === 'single' ? (
            <Input
              aria-label="Headline for the new video"
              disabled={imageOnly}
              maxLength={TEMPLATE_SHAPES.single.text}
              placeholder={imageOnly ? 'Caption disabled' : undefined}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          ) : (
            <Textarea
              aria-label="Text for the new video"
              maxLength={TEMPLATE_SHAPES.ugc.text}
              rows={2}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          )}
          <div className="flex flex-wrap items-center gap-3">
            {kind === 'single' ? (
              <Label className="flex items-center gap-2 font-normal">
                <Switch
                  aria-label="No caption (image only) for the new video"
                  checked={imageOnly}
                  onCheckedChange={setImageOnly}
                />
                No caption (image only)
              </Label>
            ) : null}
            <Button
              disabled={disabled || adding || (!text.trim() && !(kind === 'single' && imageOnly))}
              size="sm"
              type="button"
              onClick={() => void add()}
            >
              Add video
            </Button>
          </div>
        </div>
      </Row>
      {concepts.length ? (
        <ol aria-label={`${copy.title} in this batch`} className="grid gap-4">
          {concepts.map((item, index) => (
            <ConceptCard
              key={item.id}
              disabled={disabled || running}
              index={index}
              item={item}
              kind={kind}
              status={status(item)}
              upload={upload}
              onUpdate={(change) => update(item, change)}
            />
          ))}
        </ol>
      ) : null}
      {concepts.length || finished.length ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {running || toRender.length ? (
              <Button disabled={running} onClick={() => void render(toRender)}>
                {running
                  ? 'Rendering…'
                  : `Render ${toRender.length} video${toRender.length === 1 ? '' : 's'}`}
              </Button>
            ) : null}
            {running ? (
              <Button variant="outline" onClick={stop}>
                Stop
              </Button>
            ) : null}
            {finished.length ? (
              <Button
                disabled={running}
                variant="outline"
                onClick={() => void downloadAll(finished, `${copy.file}s.zip`)}
              >
                Download all ({finished.length})
              </Button>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            Videos render here in this tab: finished videos are saved, and leaving stops the one in
            progress. Finished videos are posts of this batch: set their captions and times below,
            then save and schedule them.
          </p>
        </div>
      ) : null}
    </Section>
  )
}
