'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { DeleteIcon } from '@/components/platform-shell/icons'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { normalizeAudioType } from '@/lib/animation/audio-type'
import { MAX_AUDIO_BYTES } from '@/lib/animation/motion-schema'
import {
  type BatchGrid,
  type BatchItem,
  type BatchItemInput,
  type BatchRun,
  BATCH_ITEM_LIMIT,
  GRID_HEADLINE_LIMIT,
  GRID_TOPIC_LIMIT,
} from '@/lib/api/contracts/content-batches'
import { call } from '@/lib/content-drafts/client'
import { assetContentUrl } from '@/lib/editor/services'
import { runPool } from '@/lib/export/batch'
import { zipFiles } from '@/lib/export/zip'
import { downloadBlob } from '@/lib/image-tools/download'
import { useTRPCClient } from '@/lib/trpc/react'
import { safeAssetFileName, saveExportToWorkspace } from '@/lib/workspace/save-export'
import {
  assembleConcepts,
  fillEmptySlots,
  GRID_MAX_CONCEPTS,
  gridInputProblem,
  gridReady,
  missingImages,
  redrawConcept,
  withLastCell,
  withSlot,
} from '@/lib/write/grid-concepts'
import { GRID_PRESETS } from '@/lib/write/grid-presets'
import { renderGridVideo } from '@/lib/write/grid-render'
import { FilePicker } from './FilePicker'

const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp'
const AUDIO_ACCEPT = 'audio/mpeg,audio/mp4,audio/aac,audio/wav,audio/ogg,audio/webm,.mp3,.m4a,.wav'
/** Images drawn at once: quick, and well inside the per-minute AI limit. */
const IMAGE_CONCURRENCY = 2
/** What one image usually costs: a credit is a cent, and the fallback price is four cents. */
const CREDITS_PER_IMAGE = 4

type Stage = 'inputs' | 'customize' | 'render'
type Saved = BatchItem & { grid: BatchGrid }

/** An editable list of lines: captions or content items. */
function LineList({
  addLabel,
  label,
  lines,
  maxLength,
  onChange,
  onSuggest,
  suggesting,
}: {
  addLabel: string
  label: string
  lines: string[]
  maxLength?: number
  onChange: (lines: string[]) => void
  onSuggest: () => void
  suggesting: boolean
}) {
  const filled = lines.filter((line) => line.trim()).length
  return (
    <div className="grid gap-2">
      {lines.map((line, index) => (
        <div className="flex items-center gap-2" key={index}>
          <Input
            aria-label={`${label} ${index + 1}`}
            maxLength={maxLength}
            value={line}
            onChange={(event) =>
              onChange(lines.map((other, at) => (at === index ? event.target.value : other)))
            }
          />
          {lines.length > 1 ? (
            <Button
              aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
              size="icon-sm"
              type="button"
              variant="ghost"
              onClick={() => onChange(lines.filter((_, at) => at !== index))}
            >
              <DeleteIcon />
            </Button>
          ) : null}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" type="button" variant="outline" onClick={() => onChange([...lines, ''])}>
          {addLabel}
        </Button>
        {filled ? (
          <Button disabled={suggesting} size="sm" type="button" variant="ghost" onClick={onSuggest}>
            {suggesting ? 'Suggesting…' : 'Suggest more with AI'}
          </Button>
        ) : null}
        <span className="text-xs text-muted-foreground">{filled} added</span>
      </div>
    </div>
  )
}

/**
 * Grid videos (a headline above four labelled images, with optional music).
 * Each concept is a batch item, so a fresh tab comes back to it, and each
 * finished video is saved on its item at once: closing the tab loses only the
 * video being rendered. From then on it is an ordinary post of the batch.
 */
export function GridCreator({
  base,
  disabled,
  items,
  lastRender,
  onAdd,
  onApply,
  onReload,
  onUpdate,
  sharedAccounts,
}: {
  /** The batch's API path. */
  base: string
  disabled: boolean
  items: BatchItem[]
  /** The batch's latest render, so its failures survive a reload. */
  lastRender?: BatchRun
  onReload: () => Promise<void>
  onAdd: (inputs: BatchItemInput[]) => Promise<void>
  onApply: (changes: ({ itemId: string } & Record<string, unknown>)[]) => Promise<void>
  onUpdate: (
    item: BatchItem,
    body: (latest: BatchItem) => Record<string, unknown>
  ) => Promise<unknown>
  sharedAccounts: string[]
}) {
  const trpc = useTRPCClient()
  const concepts = items.filter((item): item is Saved => Boolean(item.grid && !item.draftId))
  // A saved draft's video can still be downloaded, though its concept no longer changes.
  const finished = items.filter((item): item is Saved =>
    Boolean(item.grid && item.media.some((entry) => entry.assetId))
  )
  const [stage, setStage] = React.useState<Stage>(concepts.length ? 'customize' : 'inputs')

  const [captions, setCaptions] = React.useState([''])
  const [lines, setLines] = React.useState([''])
  const [count, setCount] = React.useState(5)
  const [problem, setProblem] = React.useState('')
  const [suggesting, setSuggesting] = React.useState<'captions' | 'items' | null>(null)

  const suggest = async (kind: 'captions' | 'items') => {
    const current = kind === 'captions' ? captions : lines
    const set = kind === 'captions' ? setCaptions : setLines
    setSuggesting(kind)
    try {
      const { lines: more } = await trpc.editorAi.suggestGridLines.mutate({
        count: 4,
        existing: current.map((line) => line.trim()).filter(Boolean),
        kind,
      })
      set([...current.filter((line) => line.trim()), ...more])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No suggestions came back.')
    } finally {
      setSuggesting(null)
    }
  }

  const generate = async () => {
    const wrong = gridInputProblem({ captions, items: lines })
    setProblem(wrong ?? '')
    if (wrong) return
    if (items.length + count > BATCH_ITEM_LIMIT) {
      setProblem(`A batch holds up to ${BATCH_ITEM_LIMIT} posts. Make fewer videos.`)
      return
    }
    await onAdd(
      assembleConcepts({ captions, count, items: lines }).map((grid) => ({
        caption: grid.headline,
        channelConnectionIds: sharedAccounts,
        grid,
        importKey: `grid-${crypto.randomUUID()}`,
        media: [],
        timing: {},
      }))
    )
    setStage('customize')
  }

  // Customize: images per slot, generated or uploaded, saved as each one arrives.
  const [slotState, setSlotState] = React.useState<Record<string, string>>({})
  const [creditsLeft, setCreditsLeft] = React.useState<number | null>(null)
  const missing = missingImages(concepts.map((item) => item.grid))
  React.useEffect(() => {
    if (stage !== 'customize') return
    void trpc.billing.summary.query().then(
      ({ creditBalance, credits }) => setCreditsLeft(credits.left + creditBalance),
      () => setCreditsLeft(null)
    )
  }, [stage, trpc])

  const setSlot = (item: Saved, index: number, change: Partial<BatchGrid['slots'][number]>) =>
    onUpdate(item, (latest) => ({ grid: withSlot(latest.grid ?? item.grid, index, change) }))

  const drawSlot = async (item: Saved, index: number) => {
    const key = `${item.id}/${index}`
    setSlotState((current) => ({ ...current, [key]: 'Generating…' }))
    try {
      const { assetId } = await trpc.editorAi.generateGridSlotImage.mutate({
        headline: item.grid.headline,
        topic: item.grid.slots[index]!.topic,
      })
      await setSlot(item, index, { assetId })
      setSlotState(({ [key]: _done, ...rest }) => rest)
    } catch (error) {
      setSlotState((current) => ({
        ...current,
        [key]: error instanceof Error ? error.message : 'The image could not be generated.',
      }))
    }
  }

  const drawAll = async () => {
    const empty = concepts.flatMap((item) =>
      item.grid.slots.flatMap((slot, index) => (slot.assetId ? [] : [{ index, item }]))
    )
    await runPool(empty, IMAGE_CONCURRENCY, ({ index, item }) => drawSlot(item, index))
  }

  const upload = async (file: File, fileName = file.name) => {
    const { assetId } = await saveExportToWorkspace({
      blob: file,
      fileName: safeAssetFileName(fileName) || 'grid-file',
      trpcClient: trpc,
    })
    return assetId
  }

  const uploadSlot = async (item: Saved, index: number, file: File | undefined) => {
    if (!file) return
    const key = `${item.id}/${index}`
    setSlotState((current) => ({ ...current, [key]: 'Uploading…' }))
    try {
      await setSlot(item, index, { assetId: await upload(file) })
      setSlotState(({ [key]: _done, ...rest }) => rest)
    } catch (error) {
      setSlotState((current) => ({
        ...current,
        [key]: error instanceof Error ? error.message : 'The image could not be uploaded.',
      }))
    }
  }

  const [uploading, setUploading] = React.useState('')
  const [unused, setUnused] = React.useState<string[]>([])
  const uploadAll = async (files: File[]) => {
    if (!files.length) return
    // Only the images slots can take are uploaded; the rest are named.
    const taken = files.slice(0, missing)
    setUnused(files.slice(missing).map((file) => file.name))
    setUploading(`Uploading ${taken.length} images…`)
    try {
      const ids: string[] = []
      await runPool(taken, 3, async (file, index) => {
        ids[index] = await upload(file)
      })
      const { filled } = fillEmptySlots(
        concepts.map((item) => item.grid),
        ids
      )
      await onApply(concepts.map((item, index) => ({ grid: filled[index]!, itemId: item.id })))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The images could not be uploaded.')
    } finally {
      setUploading('')
    }
  }

  // A new headline comes from AI, working from the batch's others so it stays on topic.
  const [regenerating, setRegenerating] = React.useState<string | null>(null)
  const newHeadline = async (item: Saved) => {
    const { lines: [headline] = [] } = await trpc.editorAi.suggestGridLines.mutate({
      count: 1,
      existing: [...new Set(concepts.map((other) => other.grid.headline))].slice(0, 50),
      kind: 'captions',
    })
    return headline ?? item.grid.headline
  }
  const withCaption = (item: Saved, latest: BatchItem, grid: BatchGrid) => ({
    grid,
    // A caption still equal to the headline follows it.
    ...(latest.caption === item.grid.headline ? { caption: grid.headline } : {}),
  })
  const regenerateCaption = async (item: Saved) => {
    setRegenerating(item.id)
    try {
      const headline = await newHeadline(item)
      await onUpdate(item, (latest) =>
        withCaption(item, latest, { ...(latest.grid ?? item.grid), headline })
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'No new caption came back.')
    } finally {
      setRegenerating(null)
    }
  }
  const regenerateVideo = async (item: Saved) => {
    if (!window.confirm('Regenerate this video? Its caption and images are replaced.')) return
    setRegenerating(item.id)
    try {
      // Without AI the items still change: the new headline is what needs it.
      const headline = await newHeadline(item).catch(() => {
        toast.info('No new caption came back, so this video keeps its headline.')
        return item.grid.headline
      })
      const pool = [...lines, ...concepts.flatMap((other) => other.grid.slots.map((s) => s.topic))]
      await onUpdate(item, (latest) =>
        withCaption(item, latest, {
          ...redrawConcept(latest.grid ?? item.grid, pool),
          headline,
        })
      )
    } finally {
      setRegenerating(null)
    }
  }

  const [lastTopic, setLastTopic] = React.useState('')
  const [lastImage, setLastImage] = React.useState<{ assetId: string; name: string } | null>(null)
  const applyLastCell = () =>
    onApply(
      concepts.map((item) => ({
        grid: withLastCell(item.grid, { assetId: lastImage?.assetId, topic: lastTopic }),
        itemId: item.id,
      }))
    )

  const uploadMusic = async (file: File | undefined, targets: Saved[]) => {
    if (!file) return
    const type = normalizeAudioType(file.type, file.name)
    if (!type) {
      toast.error('Choose an MP3, M4A/AAC, WAV, Ogg, or WebM audio file.')
      return
    }
    if (file.size > MAX_AUDIO_BYTES) {
      toast.error(`Choose an audio file under ${MAX_AUDIO_BYTES / 1024 / 1024} MB.`)
      return
    }
    setUploading('Uploading music…')
    try {
      const musicAssetId = await upload(new File([file], file.name, { type }))
      await onApply(
        targets.map((item) => ({ grid: { ...item.grid, musicAssetId }, itemId: item.id }))
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The music could not be uploaded.')
    } finally {
      setUploading('')
    }
  }

  const removeMusic = () =>
    onApply(
      concepts.map(({ grid: { musicAssetId: _gone, ...grid }, id }) => ({ grid, itemId: id }))
    )

  // Render: one video at a time, each saved on its item as soon as it is done.
  const [progress, setProgress] = React.useState<Record<string, number | string>>(() =>
    Object.fromEntries(
      (lastRender?.items ?? []).flatMap((entry) =>
        entry.status === 'FAILED' && entry.error ? [[entry.itemId, entry.error]] : []
      )
    )
  )
  const [running, setRunning] = React.useState(false)
  const abort = React.useRef<AbortController | null>(null)
  const toRender = concepts.filter(
    (item) => gridReady(item.grid) && !item.media.some((entry) => entry.assetId)
  )

  React.useEffect(() => {
    if (!running) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [running])
  React.useEffect(() => () => abort.current?.abort(), [])

  const render = async () => {
    const controller = new AbortController()
    abort.current = controller
    setRunning(true)
    setProgress({})
    try {
      // The server freezes each concept, so a video cannot land on one that changed since.
      const run = await call<BatchRun>(`${base}/renders`, {
        body: {
          itemIds: toRender.map((item) => item.id),
          requestKey: `render-${crypto.randomUUID()}`,
        },
        method: 'POST',
      })
      const report = `${base}/renders/${encodeURIComponent(run.id)}/items`
      await runPool(
        run.items,
        1,
        async (entry) => {
          const url = `${report}/${encodeURIComponent(entry.itemId)}`
          try {
            const blob = await renderGridVideo(entry.grid!, controller.signal, (fraction) =>
              setProgress((current) => ({ ...current, [entry.itemId]: fraction }))
            )
            const item = concepts.find((candidate) => candidate.id === entry.itemId)
            const fileName = `grid-video-${(item?.position ?? 0) + 1}.mp4`
            const { assetId } = await saveExportToWorkspace({ blob, fileName, trpcClient: trpc })
            await call(url, { body: { assetId, fileName }, method: 'POST' })
            setProgress((current) => ({ ...current, [entry.itemId]: 1 }))
            await onReload()
          } catch (error) {
            if (controller.signal.aborted) return
            const message =
              error instanceof Error ? error.message : 'This video could not be rendered.'
            setProgress((current) => ({ ...current, [entry.itemId]: message }))
            // Recorded so the failure is still here after a reload; losing the record is harmless.
            await call(url, { body: { error: message }, method: 'POST' }).catch(() => undefined)
          }
        },
        controller.signal
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The videos could not be rendered.')
    } finally {
      setRunning(false)
    }
  }

  const fetchVideo = async (item: Saved) => {
    const assetId = item.media.find((entry) => entry.assetId)?.assetId
    const response = await fetch(assetContentUrl(assetId!))
    if (!response.ok) throw new Error('A video could not be downloaded.')
    return response.blob()
  }
  const videoName = (item: Saved) => `grid-video-${item.position + 1}.mp4`
  const downloadAll = async () => {
    try {
      if (finished.length === 1) {
        downloadBlob(await fetchVideo(finished[0]!), videoName(finished[0]!))
        return
      }
      const entries = await Promise.all(
        finished.map(async (item) => ({ data: await fetchVideo(item), path: videoName(item) }))
      )
      downloadBlob(await zipFiles(entries), 'grid-videos.zip')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The videos could not be downloaded.')
    }
  }

  const stages: { key: Stage; label: string }[] = [
    { key: 'inputs', label: 'Captions and items' },
    { key: 'customize', label: 'Customize' },
    { key: 'render', label: 'Render' },
  ]
  const requiredCredits = missing * CREDITS_PER_IMAGE

  return (
    <Section
      title="Grid videos"
      description="Each video shows a headline above four labelled images for six seconds, at 1080×1920. Each one becomes a post of this batch."
    >
      <ol aria-label="Grid video steps" className="flex flex-wrap gap-2 text-sm">
        {stages.map(({ key, label }, index) => (
          <li key={key}>
            <Button
              aria-current={stage === key ? 'step' : undefined}
              disabled={running || (key !== 'inputs' && !concepts.length)}
              size="sm"
              type="button"
              variant={stage === key ? 'default' : 'ghost'}
              onClick={() => setStage(key)}
            >
              {index + 1}. {label}
            </Button>
          </li>
        ))}
      </ol>

      {stage === 'inputs' ? (
        <>
          <Group>
            <Row label="Quick start">
              <Select
                defaultValue="none"
                onValueChange={(name) => {
                  const preset = GRID_PRESETS.find((entry) => entry.name === name)
                  setCaptions(preset ? [...preset.captions] : [''])
                  setLines(preset ? [...preset.items] : [''])
                  setProblem('')
                }}
              >
                <SelectTrigger aria-label="Quick start">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {GRID_PRESETS.map((preset) => (
                    <SelectItem key={preset.name} value={preset.name}>
                      {preset.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row
              label="Video captions"
              layout="stacked"
              description="The headline written into each video. Videos take turns using them."
            >
              <LineList
                addLabel="Add a caption"
                label="Caption"
                lines={captions}
                maxLength={GRID_HEADLINE_LIMIT}
                onChange={setCaptions}
                onSuggest={() => void suggest('captions')}
                suggesting={suggesting === 'captions'}
              />
            </Row>
            <Row
              label="Content items"
              layout="stacked"
              description="What the images can show. Each video picks four, in its own order, so you need at least four."
            >
              <LineList
                addLabel="Add an item"
                label="Item"
                lines={lines}
                maxLength={GRID_TOPIC_LIMIT}
                onChange={setLines}
                onSuggest={() => void suggest('items')}
                suggesting={suggesting === 'items'}
              />
            </Row>
            <Row label={`Videos: ${count}`}>
              <Slider
                aria-label="Number of videos"
                className="w-full max-w-sm"
                max={GRID_MAX_CONCEPTS}
                min={1}
                value={[count]}
                onValueChange={([next]) => setCount(next ?? 1)}
              />
            </Row>
          </Group>
          {problem ? (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          ) : null}
          <div>
            <Button disabled={disabled} onClick={() => void generate()}>
              Make {count} video concept{count === 1 ? '' : 's'}
            </Button>
          </div>
        </>
      ) : null}

      {stage === 'customize' ? (
        <>
          <Group>
            <Row layout="stacked" label="Images for all videos">
              <p className="text-sm" data-testid="grid-readiness">
                {concepts.filter((item) => gridReady(item.grid)).length} of {concepts.length} videos
                ready · {missing} image{missing === 1 ? '' : 's'} missing
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  disabled={disabled || !missing}
                  size="sm"
                  type="button"
                  onClick={() => void drawAll()}
                >
                  Generate all ({missing})
                </Button>
                <FilePicker
                  accept={IMAGE_ACCEPT}
                  label="Upload images for all videos"
                  multiple
                  onFiles={(files) => void uploadAll(files)}
                >
                  Upload images
                </FilePicker>
                {uploading ? (
                  <span className="text-xs text-muted-foreground" role="status">
                    {uploading}
                  </span>
                ) : null}
              </div>
              {missing ? (
                <p
                  className={
                    creditsLeft !== null && requiredCredits > creditsLeft
                      ? 'text-xs text-destructive'
                      : 'text-xs text-muted-foreground'
                  }
                >
                  Generating {missing} images uses about {requiredCredits} AI credits
                  {creditsLeft !== null ? `; you have ${creditsLeft}` : ''}. Uploading {missing}{' '}
                  fills the empty slots in order.
                </p>
              ) : null}
              {unused.length ? (
                <p className="text-xs text-muted-foreground">
                  Not used, every slot was filled: {unused.join(', ')}
                </p>
              ) : null}
            </Row>
            <Row
              layout="stacked"
              label="Last grid cell"
              description="The bottom right cell of every video, for a call to action. Leave a field empty to keep each video's own."
            >
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label="Last cell label"
                  className="max-w-sm"
                  maxLength={GRID_TOPIC_LIMIT}
                  placeholder="Label"
                  value={lastTopic}
                  onChange={(event) => setLastTopic(event.target.value)}
                />
                <FilePicker
                  accept={IMAGE_ACCEPT}
                  label="Last cell image"
                  onFiles={([file]) => {
                    if (!file) return
                    void upload(file)
                      .then((assetId) => setLastImage({ assetId, name: file.name }))
                      .catch((error: unknown) =>
                        toast.error(error instanceof Error ? error.message : 'Upload failed.')
                      )
                  }}
                >
                  {lastImage ? lastImage.name : 'Choose an image'}
                </FilePicker>
                <Button
                  disabled={disabled || (!lastTopic.trim() && !lastImage)}
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={() => void applyLastCell()}
                >
                  Apply to all videos
                </Button>
              </div>
            </Row>
            <Row
              layout="stacked"
              label="Music"
              description="Your own audio file, played from its start. Make sure you have the rights to use it. Videos without music are silent."
            >
              <div className="flex flex-wrap items-center gap-2">
                <FilePicker
                  accept={AUDIO_ACCEPT}
                  label="Music for all videos"
                  onFiles={([file]) => void uploadMusic(file, concepts)}
                >
                  Upload for all videos
                </FilePicker>
                {concepts.some((item) => item.grid.musicAssetId) ? (
                  <Button
                    disabled={disabled}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => void removeMusic()}
                  >
                    Remove music
                  </Button>
                ) : null}
              </div>
            </Row>
          </Group>
          <ol aria-label="Grid video concepts" className="grid gap-4">
            {concepts.map((item, conceptIndex) => (
              <li
                key={item.id}
                className="grid gap-3 rounded-2xl border border-border p-4"
                data-testid="grid-concept"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Label className="min-w-0 flex-1 font-normal">
                    <span className="sr-only">Headline for video {conceptIndex + 1}</span>
                    <Input
                      key={item.grid.headline}
                      defaultValue={item.grid.headline}
                      maxLength={GRID_HEADLINE_LIMIT}
                      onBlur={(event) => {
                        const headline = event.target.value.trim()
                        if (!headline || headline === item.grid.headline) return
                        void onUpdate(item, (latest) => ({
                          grid: { ...(latest.grid ?? item.grid), headline },
                          // A caption still equal to the headline follows it.
                          ...(latest.caption === item.grid.headline ? { caption: headline } : {}),
                        }))
                      }}
                    />
                  </Label>
                  <Pill tone={gridReady(item.grid) ? 'green' : 'gray'}>
                    {gridReady(item.grid)
                      ? 'Ready'
                      : `${item.grid.slots.filter((slot) => slot.assetId).length} of 4 images`}
                  </Pill>
                  <FilePicker
                    accept={AUDIO_ACCEPT}
                    label={`Music for video ${conceptIndex + 1}`}
                    onFiles={([file]) => void uploadMusic(file, [item])}
                  >
                    {item.grid.musicAssetId ? 'Change music' : 'Add music'}
                  </FilePicker>
                  <Button
                    aria-label={`New caption for video ${conceptIndex + 1}`}
                    disabled={disabled || regenerating === item.id}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => void regenerateCaption(item)}
                  >
                    New caption
                  </Button>
                  <Button
                    aria-label={`Regenerate video ${conceptIndex + 1}`}
                    disabled={disabled || regenerating === item.id}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => void regenerateVideo(item)}
                  >
                    Regenerate video
                  </Button>
                </div>
                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {item.grid.slots.map((slot, index) => {
                    const state = slotState[`${item.id}/${index}`]
                    const name = `video ${conceptIndex + 1} image ${index + 1}`
                    return (
                      <li key={index} className="grid content-start gap-2">
                        <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl border border-border bg-muted text-xs text-muted-foreground">
                          {slot.assetId ? (
                            <img
                              alt={slot.topic}
                              className="size-full object-cover"
                              src={assetContentUrl(slot.assetId)}
                            />
                          ) : (
                            'No image'
                          )}
                        </div>
                        <Input
                          key={slot.topic}
                          aria-label={`Label for ${name}`}
                          defaultValue={slot.topic}
                          maxLength={GRID_TOPIC_LIMIT}
                          onBlur={(event) => {
                            if (event.target.value !== slot.topic)
                              void setSlot(item, index, { topic: event.target.value })
                          }}
                        />
                        <div className="flex flex-wrap gap-1">
                          <FilePicker
                            accept={IMAGE_ACCEPT}
                            label={`Upload ${name}`}
                            onFiles={([file]) => void uploadSlot(item, index, file)}
                          >
                            Upload
                          </FilePicker>
                          <Button
                            aria-label={`Generate ${name}`}
                            disabled={disabled || state === 'Generating…'}
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() => void drawSlot(item, index)}
                          >
                            Generate
                          </Button>
                        </div>
                        {state ? (
                          <p
                            role={state.endsWith('…') ? 'status' : 'alert'}
                            className={
                              state.endsWith('…')
                                ? 'text-xs text-muted-foreground'
                                : 'text-xs text-destructive'
                            }
                          >
                            {state}
                          </p>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={!concepts.some((item) => gridReady(item.grid))}
              onClick={() => setStage('render')}
            >
              Continue to render
            </Button>
            <Button variant="ghost" onClick={() => setStage('inputs')}>
              Add more concepts
            </Button>
          </div>
        </>
      ) : null}

      {stage === 'render' ? (
        <>
          <Group>
            <Row layout="stacked" label="Videos">
              <p className="text-sm text-muted-foreground">
                {toRender.length} to render, {finished.length} done. They render here in this tab:
                finished videos are saved, and leaving stops the one in progress.
              </p>
              <ul className="grid gap-2 text-sm" data-testid="grid-render-list">
                {concepts
                  .filter((item) => gridReady(item.grid))
                  .map((item) => {
                    const state = progress[item.id]
                    const done = item.media.some((entry) => entry.assetId)
                    return (
                      <li key={item.id} className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">{item.grid.headline}</span>
                        {done ? (
                          <>
                            <Pill tone="green">Done</Pill>
                            <Button
                              aria-label={`Download ${item.grid.headline}`}
                              size="sm"
                              type="button"
                              variant="ghost"
                              onClick={() =>
                                void fetchVideo(item).then(
                                  (blob) => downloadBlob(blob, videoName(item)),
                                  () => toast.error('The video could not be downloaded.')
                                )
                              }
                            >
                              Download
                            </Button>
                          </>
                        ) : typeof state === 'string' ? (
                          <span role="alert" className="text-destructive">
                            {state}
                          </span>
                        ) : typeof state === 'number' ? (
                          <span role="status" className="text-muted-foreground tabular-nums">
                            Rendering {Math.round(state * 100)}%
                          </span>
                        ) : (
                          <Pill tone="gray">Waiting</Pill>
                        )}
                      </li>
                    )
                  })}
              </ul>
            </Row>
          </Group>
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={running || !toRender.length} onClick={() => void render()}>
              {running
                ? 'Rendering…'
                : `Render ${toRender.length} video${toRender.length === 1 ? '' : 's'}`}
            </Button>
            {running ? (
              <Button variant="outline" onClick={() => abort.current?.abort()}>
                Stop
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setStage('customize')}>
                Back to customize
              </Button>
            )}
            {finished.length ? (
              <Button disabled={running} variant="outline" onClick={() => void downloadAll()}>
                Download all ({finished.length})
              </Button>
            ) : null}
          </div>
          {finished.length ? (
            <p className="text-sm text-muted-foreground">
              Finished videos are posts of this batch: set their captions and times below, then save
              and schedule them.
            </p>
          ) : null}
        </>
      ) : null}
    </Section>
  )
}
