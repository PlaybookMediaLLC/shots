'use client'

import Link from 'next/link'
import * as React from 'react'
import { useDropzone } from 'react-dropzone'
import { toast } from 'sonner'
import {
  CalendarIcon,
  DeleteIcon,
  ImageIcon,
  MoreIcon,
  OutwardIcon,
  PdfIcon,
  UploadIcon,
  VideoIcon,
} from '@/components/platform-shell/icons'
import {
  Group,
  Page,
  Pill,
  type PillTone,
  Section,
} from '@/components/platform-ui'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DatePicker } from '@/components/ui/date-picker'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { TimePicker } from '@/components/ui/time-picker'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  BATCH_ITEM_LIMIT,
  BATCH_MEDIA_LIMIT,
  type BatchItem,
  type BatchItemInput,
  type BatchMedia,
  type BatchRun,
  type BatchValidation,
  type ContentBatch,
} from '@/lib/api/contracts/content-batches'
import { call, DraftRequestError, draftsApi } from '@/lib/content-drafts/client'
import { POST_STATE_TONE, postFailureReason, postState } from '@/lib/content-drafts/post-status'
import { assetContentUrl } from '@/lib/editor/services'
import { useTRPCClient } from '@/lib/trpc/react'
import {
  type BatchAccount,
  batchAudience,
  batchSummary,
  hasLivePosts,
  hourlyWindow,
  intakeChecks,
  itemAccounts,
  pendingAccounts,
  plainTextDraft,
  plannedText,
  postOn,
  queueTimings,
  readTiming,
  runOutcomes,
  shortWhen,
  spreadHourOptions,
  spreadTimings,
  stagedBody,
  stagedChecks,
  stagedVersions,
  waitingToRender,
} from '@/lib/write/batch'
import {
  channelProblem,
  type ImportMapping,
  type ImportRow,
  isAssetId,
  matchRowMedia,
  parseBatchCSV,
  unusedFiles,
} from '@/lib/write/bulk-import'
import { groupFiles, isInFolder, storedFileName } from '@/lib/write/bulk-intake'
import { CAPABILITIES } from '@/lib/write/capabilities'
import { platformCaptionLength } from '@/lib/content-drafts/serialize'
import type { DraftChannel, VersionOptions } from '@/lib/write/document'
import { importedBody } from '@/lib/write/import-text'
import { blankDraftContext } from '@/lib/write/composing-session'
import {
  countingChannelFor,
  measurePieces,
  PASTE_PIECE_LIMIT,
  readPaste,
} from '@/lib/write/paste-split'
import { wallTime } from '@/lib/write/zoned-time'
import { CHANNEL_META, ChannelIcon } from '@/components/drafts/channel-meta'
import { CaretDownIcon } from '@phosphor-icons/react/dist/ssr/CaretDown'
import { EyeIcon } from '@phosphor-icons/react/dist/ssr/Eye'
import { uploadByteLimit } from '@/lib/write/media-limits'
import { clock } from '@/lib/write/media-rules'
import { cn } from '@/lib/utils'
import { safeAssetFileName, saveExportToWorkspace } from '@/lib/workspace/save-export'
import { expandSpintax } from '@/lib/write/spintax'
import { POST_TEXT, PostAuthor, PostCount } from '../composer/post-identity'
import { VideoOptions } from '../composer/video-options'
import { type PasteChoice } from '../paste-split'
import { useKeys } from '../shortcuts'
import { type Destination, DestinationSummary, destinationName } from '../destination-summary'
import { BatchPreviewSheet } from './BatchPreview'
import { BulkCaptionPanel } from './BulkCaptionPanel'
import { FilePicker } from './FilePicker'
import { FileThumb, ImportReview, type Staged } from './ImportReview'
import { GridCreator } from './GridCreator'

/** Files a batch takes: the formats some destination publishes; a PDF goes to LinkedIn as a document. */
const ACCEPT =
  'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,application/pdf'
/** Uploads at once: enough to keep a link busy, few enough to bound memory and sockets. */
const VIDEO_ACCEPT = 'video/mp4,video/quicktime,video/webm'
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif'
const UPLOAD_CONCURRENCY = 3
/** Items checked per request. */
const VALIDATE_CHUNK = 25
/** How often a running schedule's progress is read. */
const SUBMIT_POLL_MS = 1500

/** A saved attachment as an item's next save sends it. */
function mediaInput({
  assetId,
  bytes,
  fileName,
  uploadAssetId,
}: BatchItem['media'][number]): BatchMedia {
  return assetId
    ? { assetId, ...(fileName ? { fileName } : {}) }
    : { fileName: fileName!, bytes: bytes!, ...(uploadAssetId ? { uploadAssetId } : {}) }
}

/** Whether an outcome is good news or still under way, rather than something to fix. */
const settledWell = (outcome?: string) => outcome === 'Scheduled' || Boolean(outcome?.endsWith('…'))

/** Which tool a batch was started for; it narrows what the page offers first. */
export type BatchStart = 'videos' | 'images' | 'grid' | 'text'
type Upload = { progress: number; error?: string }

/** A path a person can read: '2026-11-03 09:30 (Europe/Paris)'. */
function when(at: Date | string, zone: string) {
  const date = typeof at === 'string' ? new Date(at) : at
  return `${date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: zone || undefined })}${zone ? ` (${zone})` : ''}`
}

/** A random retry key for an item and its draft. */
const importKey = () => `batch-${crypto.randomUUID()}`

/** A local time, YYYY-MM-DDTHH:mm, as a day and a time; a day picked first starts at 09:00. */
function LocalTimeFields({
  disabled,
  label,
  onChange,
  onValidityChange,
  value,
}: {
  disabled?: boolean
  label: string
  /**
   * Receives the edit, not the result: applied to the latest saved value,
   * a time typed before an earlier day change is saved keeps that day.
   */
  onChange: (edit: (current: string) => string) => void
  value: string
  onValidityChange: (valid: boolean) => void
}) {
  const [day = '', time = ''] = value ? value.split('T') : []
  return (
    <span className="flex items-center gap-1">
      <DatePicker
        aria-label={`${label} day`}
        disabled={disabled}
        value={day}
        onChange={(next) => {
          if (next) onChange((current) => `${next}T${current.split('T')[1] || time || '09:00'}`)
        }}
      />
      <TimePicker
        required={!!day}
        onValidityChange={onValidityChange}
        aria-label={`${label} time`}
        disabled={disabled}
        value={time}
        onChange={(next) => {
          if (day && next) onChange((current) => `${current.split('T')[0] || day}T${next}`)
        }}
      />
    </span>
  )
}

/** File formats as people know them. */
const FORMAT_NAMES: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/gif': 'GIF',
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'video/mp4': 'MP4',
  'video/quicktime': 'MOV',
  'video/webm': 'WebM',
}

/** One attachment of a post: its picture or kind, and where its upload stands. */
function MediaTile({
  entry,
  file,
  onRetry,
  upload,
}: {
  entry: BatchItem['media'][number]
  file?: File
  onRetry: () => void
  upload?: Upload
}) {
  const type = entry.mediaType ?? file?.type ?? ''
  const stored = entry.assetId ?? (entry.status === 'UPLOADED' ? entry.uploadAssetId : undefined)
  const picture = stored && type.startsWith('image/') ? assetContentUrl(stored) : undefined
  const Icon =
    type === 'application/pdf' ? PdfIcon : type.startsWith('video/') ? VideoIcon : ImageIcon
  const problem = Boolean(upload?.error) || entry.status === 'FAILED'
  const state =
    entry.status === 'UPLOADED'
      ? `${FORMAT_NAMES[type] ?? type}${entry.width ? ` · ${entry.width}×${entry.height}` : ''}`
      : upload?.error
        ? `Upload failed: ${upload.error}`
        : upload
          ? `Uploading ${upload.progress}%`
          : entry.fileName && !file
            ? 'Waiting for its file to be selected again'
            : entry.status === 'FAILED'
              ? 'Refused at upload; remove it or select a valid file'
              : 'Waiting to upload'
  return (
    <li className="grid w-24 content-start gap-1">
      <div className="relative flex size-24 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted">
        {picture ? (
          <img src={picture} alt="" className="size-full object-cover" />
        ) : file ? (
          // This tab's copy of the file, until the stored one can be shown.
          <FileThumb badge={entry.status !== 'UPLOADED'} className="size-full" file={file} />
        ) : (
          <Icon aria-hidden className="size-7 text-muted-foreground" />
        )}
        {entry.durationMs ? (
          <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[10px] text-white tabular-nums">
            {clock(entry.durationMs)}
          </span>
        ) : null}
        {upload && !upload.error ? (
          <span className="absolute inset-x-0 bottom-0 h-1 bg-black/30">
            <span
              className="block h-full bg-emerald-500"
              style={{ width: `${upload.progress}%` }}
            />
          </span>
        ) : null}
      </div>
      <span className="truncate text-xs" title={entry.fileName}>
        {entry.fileName ?? FORMAT_NAMES[type] ?? 'Asset'}
      </span>
      <span
        className={cn(
          'text-[11px] leading-tight',
          problem ? 'text-destructive' : 'text-muted-foreground'
        )}
      >
        {state}
      </span>
      {upload?.error ? (
        <Button
          size="sm"
          variant="link"
          className="h-auto justify-start p-0 text-xs"
          onClick={onRetry}
        >
          Try again
        </Button>
      ) : null}
    </li>
  )
}

/**
 * The writing box that ends a batch's posts, drawn as a post being written.
 * One post, or a paste of several: lines of dashes separate posts, and a
 * paste of plain paragraphs stays one post unless the writer chooses a
 * thread or separate posts. What each choice makes is listed before anything
 * is added, and what does not fit stays in the box.
 */
function PasteBox({
  author,
  busy,
  channel,
  focus,
  hasPosts,
  onAdd,
  restore,
  room,
}: {
  author: Destination | undefined
  busy: boolean
  channel: DraftChannel
  /** Take focus on arrival, as a text batch opens ready to type into. */
  focus: boolean
  hasPosts: boolean
  onAdd: (captions: string[], as: PasteChoice) => Promise<boolean>
  /** Words an Undo hands back; anything typed since stays ahead of them. */
  restore: { as: PasteChoice; text: string } | null
  room: number
}) {
  const { mod } = useKeys()
  const [text, setText] = React.useState('')
  const [pasteAs, setPasteAs] = React.useState<PasteChoice | null>(null)
  const [adding, setAdding] = React.useState(false)
  const box = React.useRef<HTMLTextAreaElement>(null)
  React.useEffect(() => {
    if (focus) box.current?.focus()
  }, [focus])
  React.useEffect(() => {
    if (!restore) return
    setText((current) => (current.trim() ? `${current}\n---\n${restore.text}` : restore.text))
    setPasteAs(restore.as)
  }, [restore])
  const reading = readPaste(text)
  const many = reading.pieces.length > 1
  const threadable = reading.pieces.length <= PASTE_PIECE_LIMIT
  const choice: PasteChoice = !many
    ? 'one'
    : pasteAs === 'thread' && !threadable
      ? 'posts'
      : (pasteAs ?? (reading.explicit ? 'posts' : 'one'))
  const captions = !reading.pieces.length
    ? []
    : choice === 'posts'
      ? reading.pieces
      : [reading.pieces.join(choice === 'thread' ? '\n---\n' : '\n\n')]
  const measured = measurePieces(choice === 'one' ? captions : reading.pieces, channel)
  const limit = CAPABILITIES[channel].captionLimit
  const addCount = Math.min(room, captions.length)
  const add = async () => {
    if (!addCount || busy) return
    const submitted = text
    setAdding(true)
    const added = await onAdd(captions.slice(0, room), choice)
    setAdding(false)
    if (!added) return
    // What did not fit stays, one post per separator; words typed meanwhile are kept.
    setText((current) => (current === submitted ? captions.slice(room).join('\n---\n') : current))
    setPasteAs(null)
  }
  return (
    <div className="relative grid gap-3 py-5 pe-4 ps-14 sm:ps-16" data-testid="batch-composer">
      <PostAuthor
        avatarUrl={author?.avatarUrl}
        channel={author?.channel ?? channel}
        handle={author?.handle}
        name={author?.displayName ?? author?.handle ?? 'New post'}
      />
      <Textarea
        ref={box}
        aria-label="Batch text posts"
        className={cn(POST_TEXT, 'min-h-16')}
        data-slot="post-text"
        placeholder={
          hasPosts
            ? 'Add another post, or paste several with a line of --- between them'
            : 'Write a post, or paste several with a line of --- between them'
        }
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            void add()
          }
        }}
      />
      {many ? (
        <div className="grid gap-2 rounded-lg border border-border bg-foreground/[0.02] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-label text-muted-foreground">Read as</span>
            <div
              aria-label="Read the paste as"
              className="inline-flex flex-wrap rounded-md border border-border p-0.5"
              role="group"
            >
              {(
                [
                  // The counts are in the line below, so the choice fits a phone's width.
                  ['one', 'One post'],
                  ['thread', 'Thread'],
                  ['posts', 'Separate posts'],
                ] as const
              ).map(([value, label]) => (
                <Button
                  aria-pressed={choice === value}
                  className={cn(
                    'h-7 rounded px-2.5 text-label',
                    choice === value
                      ? 'bg-foreground/[0.08] text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                  disabled={value === 'thread' && !threadable}
                  key={value}
                  onClick={() => setPasteAs(value)}
                  size={null}
                  title={
                    value === 'thread' && !threadable
                      ? `A thread holds up to ${PASTE_PIECE_LIMIT} posts`
                      : undefined
                  }
                  variant="custom"
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          <p className="text-label text-muted-foreground" data-testid="batch-text-summary">
            {choice === 'one'
              ? `Kept as one post with ${reading.pieces.length} paragraphs.`
              : choice === 'thread'
                ? `One thread: post 1, then ${reading.pieces.length - 1} repl${reading.pieces.length === 2 ? 'y' : 'ies'} under it.`
                : `${reading.pieces.length} posts, each its own draft.`}
            {measured.some((piece) => piece.over)
              ? ` ${measured.filter((piece) => piece.over).length} over ${CHANNEL_META[channel].label}’s limit.`
              : ''}
          </p>
          <ol aria-label="What the paste makes" className="grid gap-1">
            {/* The first rows show the shape of the run; a hundred would fill the page. */}
            {measured.slice(0, 12).map((piece, index) => (
              <li className="flex min-w-0 items-baseline gap-3 text-ui" key={index}>
                <span className="w-5 shrink-0 text-end text-label tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{piece.text.split('\n')[0]}</span>
                <span
                  className={cn(
                    'shrink-0 text-label tabular-nums',
                    piece.over ? 'text-destructive' : 'text-muted-foreground'
                  )}
                >
                  {piece.length}/{limit}
                </span>
              </li>
            ))}
          </ol>
          {measured.length > 12 ? (
            <p className="text-label text-muted-foreground">…and {measured.length - 12} more.</p>
          ) : null}
        </div>
      ) : null}
      {captions.length > room ? (
        <p className="text-label text-destructive" role="status">
          {room === 0
            ? `This batch is full: it holds ${BATCH_ITEM_LIMIT} posts. What you wrote stays here; start another batch for it.`
            : `A batch holds ${BATCH_ITEM_LIMIT} posts and has room for ${room}. The first ${room} will be added; the other ${captions.length - room} stay here, so none is lost.`}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {many ? null : (
          <PostCount
            active={text.length > 0}
            channel={channel}
            length={measured[0]?.length ?? 0}
            limit={limit}
            number={0}
            thread={false}
          />
        )}
        <Button
          className="ms-auto"
          disabled={busy || !addCount}
          onClick={() => void add()}
          size="sm"
          title={`Add to the batch (${mod}↵)`}
        >
          {adding ? 'Adding…' : addCount ? `Add ${addCount} post${addCount === 1 ? '' : 's'}` : 'Add post'}
        </Button>
      </div>
    </div>
  )
}

/** Where a post stands before scheduling: saved or not, and its review. */
function itemStatus(item: BatchItem): { text: string; tone: PillTone } {
  if (waitingToRender(item)) return { text: 'Not rendered', tone: 'gray' }
  if (!item.draftId) return { text: 'Not saved', tone: 'gray' }
  const review: Record<string, { text: string; tone: PillTone }> = {
    approved: { text: 'Approved', tone: 'green' },
    changes_requested: { text: 'Changes requested', tone: 'red' },
    pending: { text: 'In review', tone: 'yellow' },
  }
  return review[item.draft?.reviewStatus ?? ''] ?? { text: 'Draft', tone: 'blue' }
}

/** A size people read: 1.2 MB. */
const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`

/** Move focus to a block that opened away from its control, and scroll it to the top. */
function reveal(element: HTMLElement | null) {
  element?.focus({ preventScroll: true })
  element?.scrollIntoView({ block: 'start' })
}

/**
 * Bulk scheduling (RFC 042): many separate posts, each its own draft. The
 * batch lives in the backend, so a reload, a closed tab or another device
 * reopens it; only the files chosen in this tab live here, and an upload cut
 * short asks for its file again instead of claiming it finished.
 */
export function BatchWorkspace({
  initial,
  accounts,
  canPublish,
  defaults,
  start,
}: {
  initial: ContentBatch
  accounts: BatchAccount[]
  canPublish: boolean
  /** The profile's default platforms and main platform, which new posts here start on. */
  defaults?: { defaultPlatforms: string[]; primaryPlatform: string | null }
  start?: BatchStart
}) {
  const trpc = useTRPCClient()
  const [batch, setBatch] = React.useState(initial)
  const items = React.useMemo(() => batch.items ?? [], [batch.items])
  const zone = batch.timeZone || 'UTC'
  const base = `/api/v1/content-batches/${encodeURIComponent(batch.id)}`
  const reload = React.useCallback(async () => {
    setBatch(await call<ContentBatch>(base))
  }, [base])
  const replaceItem = (next: BatchItem) =>
    setBatch((current) => ({
      ...current,
      items: (current.items ?? []).map((item) => (item.id === next.id ? next : item)),
    }))

  // Files chosen in this tab, by item and attachment (`itemId/index`), so a
  // later import of a file with the same name never replaces one still needed.
  // A reload forgets them on purpose.
  const files = React.useRef(new Map<string, File>())
  const [uploads, setUploads] = React.useState<Record<string, Upload>>({})
  const queue = React.useRef<{ itemId: string; index: number }[]>([])
  const running = React.useRef(0)
  const itemsRef = React.useRef(items)
  itemsRef.current = items

  // One save at a time per item, each built from its latest state: two
  // uploads of a post finishing together must not overwrite each other, and
  // saving drafts waits for edits still on their way.
  const saving = React.useRef(new Map<string, Promise<void>>())
  const saveItem = React.useCallback(
    (itemId: string, body: (item: BatchItem) => Record<string, unknown>) => {
      const save = async () => {
        const item = itemsRef.current.find((candidate) => candidate.id === itemId)
        if (!item) return
        const next = await call<BatchItem>(`${base}/items/${encodeURIComponent(itemId)}`, {
          body: body(item),
          method: 'PATCH',
        })
        itemsRef.current = itemsRef.current.map((candidate) =>
          candidate.id === itemId ? next : candidate
        )
        replaceItem(next)
      }
      const queued = (saving.current.get(itemId) ?? Promise.resolve())
        .catch(() => undefined)
        .then(save)
      saving.current.set(itemId, queued)
      return queued
    },
    [base]
  )
  /** Wait for every save in flight, failed or not. */
  const settled = () =>
    Promise.all([...saving.current.values()].map((pending) => pending.catch(() => undefined)))
  const patchMedia = React.useCallback(
    (itemId: string, index: number, entry: BatchMedia) =>
      saveItem(itemId, (item) => ({
        media: item.media.map((current, at): BatchMedia =>
          at === index ? entry : mediaInput(current)
        ),
      })),
    [saveItem]
  )

  /**
   * Finish an attachment whose upload this tab or an earlier one reserved,
   * when its bytes are all stored. Completion is idempotent, and refuses an
   * upload whose bytes did not all arrive or that was sent in parts.
   */
  const recover = React.useCallback(
    async (itemId: string, index: number, entry: BatchItem['media'][number]) => {
      if (!entry.uploadAssetId || !entry.fileName) return false
      const done = await trpc.asset.completeUpload.mutate({ assetId: entry.uploadAssetId }).then(
        () => true,
        () => false
      )
      if (done)
        await patchMedia(itemId, index, { assetId: entry.uploadAssetId, fileName: entry.fileName })
      return done
    },
    [patchMedia, trpc]
  )

  const pump = React.useCallback(() => {
    while (running.current < UPLOAD_CONCURRENCY && queue.current.length > 0) {
      const job = queue.current.shift()!
      const item = itemsRef.current.find((candidate) => candidate.id === job.itemId)
      const entry = item?.media[job.index]
      const key = `${job.itemId}/${job.index}`
      const file = files.current.get(key)
      if (!item || !entry?.fileName || !file || entry.assetId) continue
      const fileName = entry.fileName
      running.current += 1
      setUploads((current) => ({ ...current, [key]: { progress: 0 } }))
      const upload = (resumeAssetId?: string) =>
        saveExportToWorkspace({
          blob: file,
          fileName,
          trpcClient: trpc,
          resumeAssetId,
          // Record the reservation first: after a reload it tells an upload
          // that was cut short from one that never started.
          onReserved: (assetId) =>
            patchMedia(job.itemId, job.index, {
              fileName,
              bytes: file.size,
              uploadAssetId: assetId,
            }),
          onProgress: (progress) => setUploads((current) => ({ ...current, [key]: { progress } })),
        })
      void (async () => {
        if (await recover(job.itemId, job.index, entry)) return
        // A large file sent in parts resumes from what storage holds; anything else starts again.
        const resumable =
          entry.uploadAssetId &&
          (await trpc.asset.uploadParts.mutate({ assetId: entry.uploadAssetId, parts: [] }).then(
            () => true,
            () => false
          ))
        const { assetId } = await upload(resumable ? entry.uploadAssetId : undefined)
        await patchMedia(job.itemId, job.index, { assetId, fileName })
      })()
        .then(() => setUploads(({ [key]: _done, ...rest }) => rest))
        .catch((error: unknown) =>
          setUploads((current) => ({
            ...current,
            [key]: {
              progress: 0,
              error: error instanceof Error ? error.message : 'Upload failed.',
            },
          }))
        )
        .finally(() => {
          running.current -= 1
          pump()
        })
    }
  }, [patchMedia, recover, trpc])

  /** Send an attachment whose upload failed in this tab again, finishing it first if it can. */
  const retryUpload = (itemId: string, index: number) => {
    setUploads(({ [`${itemId}/${index}`]: _failed, ...rest }) => rest)
    queue.current.push({ itemId, index })
    pump()
  }

  /** Queue every attachment whose file this tab holds and that is not stored yet. */
  const startUploads = React.useCallback(() => {
    for (const item of itemsRef.current) {
      item.media.forEach((entry, index) => {
        const key = `${item.id}/${index}`
        if (entry.assetId || !entry.fileName || !files.current.has(key)) return
        if (entry.status === 'UPLOADED' || uploads[key]?.progress !== undefined) return
        if (queue.current.some((job) => job.itemId === item.id && job.index === index)) return
        queue.current.push({ itemId: item.id, index })
      })
    }
    pump()
  }, [pump, uploads])

  // After a reload, finish uploads whose bytes all arrived before the page closed.
  React.useEffect(() => {
    for (const item of initial.items ?? [])
      item.media.forEach((entry, index) => {
        if (!entry.assetId && entry.status !== 'FAILED') void recover(item.id, index, entry)
      })
  }, [initial.items, recover])

  const missingFiles = items.flatMap((item) =>
    item.media.flatMap((entry, index) => {
      const key = `${item.id}/${index}`
      return !entry.assetId &&
        entry.status !== 'UPLOADED' &&
        entry.fileName &&
        !files.current.has(key)
        ? [{ entry, key }]
        : []
    })
  )

  // Adding items: selected files, pasted text, a CSV and shared settings, previewed first.
  const [csv, setCSV] = React.useState('')
  const [chosen, setChosen] = React.useState<File[]>([])
  const [perImage, setPerImage] = React.useState(false)
  const [videoOptions, setVideoOptions] = React.useState<VersionOptions>({})
  const [sharedCaption, setSharedCaption] = React.useState('')
  const [sharedAccounts, setSharedAccounts] = React.useState<string[]>(
    accounts.map((account) => account.id)
  )
  const [preview, setPreview] = React.useState<{
    mapping: ImportMapping | null
    skipped: { name: string; reason: string }[]
    staged: Staged[]
    unused: string[]
  } | null>(null)
  // The preview and the grid creator open in the posts column, away from the
  // rail controls that open them, so focus and the view move to them.
  const previewRef = React.useRef<HTMLDivElement>(null)
  const gridRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (preview) reveal(previewRef.current)
  }, [preview])
  const dropzone = useDropzone({ noClick: true, noKeyboard: true, onDrop: setChosen })
  const folderChosen = chosen.some(isInFolder)
  const destinations = accounts.map((account) => ({
    avatarUrl: account.avatarUrl,
    channel: account.channel,
    displayName: account.displayName ?? account.name,
    handle: account.handle ?? null,
    id: account.id,
  }))
  const destinationsOf = (ids: readonly string[]) =>
    destinations.filter((account) => ids.includes(account.id))
  // New posts start on the accounts a new draft in this profile would: those
  // this session last chose, else the profile's default platforms. Read after
  // mount, because the session lives in the browser.
  React.useEffect(() => {
    if (!defaults) return
    const opening = blankDraftContext({
      ...defaults,
      accounts: destinations,
      id: batch.socialSetId,
    })
    if (opening.accounts.length) setSharedAccounts(opening.accounts.map((account) => account.id))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Pasted posts, measured for the tightest platform they go to before they are staged.
  const countingChannel = countingChannelFor(
    accounts.filter((account) => sharedAccounts.includes(account.id))
  )
  /** A post's caption length as its own tightest platform counts it; a saved draft reports its own text. */
  const itemChannel = (item: BatchItem) =>
    countingChannelFor(accounts.filter((account) => itemAccounts(item).includes(account.id)))
  const captionLength = (item: BatchItem) =>
    platformCaptionLength(itemChannel(item), item.draft?.plainText ?? item.caption)
  const [busy, setBusy] = React.useState<string | null>(null)

  const previewImport = async () => {
    try {
      // Folders group their files into posts; the preview shows how before anything is added.
      if (!csv.trim() && (perImage || folderChosen)) {
        const { posts, skipped } = groupFiles(chosen, perImage ? 'per-image' : 'folder')
        if (items.length + posts.length > BATCH_ITEM_LIMIT)
          throw new Error(
            `A batch holds up to ${BATCH_ITEM_LIMIT} posts; this would make ${items.length + posts.length}.`
          )
        setPreview({
          mapping: null,
          skipped,
          unused: [],
          staged: posts.map((post, index) => {
            const checked = intakeChecks(
              destinationsOf(sharedAccounts).map((account) => account.channel),
              post.files
            )
            return {
              files: post.files,
              line: index + 1,
              notes: checked.notes,
              problems: [...post.problems, ...checked.problems],
              input: {
                importKey: importKey(),
                caption: expandSpintax(sharedCaption),
                media: post.files.map((file, at) => ({
                  bytes: file.size,
                  fileName: post.storedNames[at]!,
                })),
                channelConnectionIds: sharedAccounts,
                sourceKey: post.sourceKey,
                timing: {},
              },
            }
          }),
        })
        return
      }
      if (chosen.length + items.length > BATCH_ITEM_LIMIT && !csv.trim())
        throw new Error(
          `A batch holds up to ${BATCH_ITEM_LIMIT} posts. Choose fewer files or start another batch.`
        )
      const known = new Set<string>()
      let mapping: ImportMapping | null = null
      let rows: ImportRow[]
      if (csv.trim()) {
        const parsed = parseBatchCSV(csv)
        mapping = parsed.mapping
        rows = parsed.rows
        // Confirm each asset ID the CSV names belongs to this workspace.
        const ids = [...new Set(rows.flatMap((row) => row.assets))].filter(
          (token) => isAssetId(token) && !chosen.some((file) => file.name === token)
        )
        // Go checks the workspace and upload status without reading the file, whatever its size.
        await Promise.all(
          ids.map((id) =>
            trpc.asset.signDownload.query({ assetId: id }).then(
              () => known.add(id),
              () => undefined
            )
          )
        )
      } else {
        rows = chosen.map((file, index) => ({
          line: index + 1,
          caption: '',
          assets: [file.name],
          channels: [],
          problems: [],
        }))
      }
      const connected = accounts.map((account) => account.channel)
      const staged = rows.map((row): Staged => {
        const matched = matchRowMedia(row, chosen, known)
        const channelIssue = channelProblem(row.channels, connected)
        const rowFiles = matched.media.map((media) =>
          'fileName' in media
            ? chosen.find((file) => safeAssetFileName(file.name) === media.fileName)
            : undefined
        )
        const tooLarge = rowFiles.flatMap((file) =>
          file && file.size > uploadByteLimit(file.type)
            ? [`${file.name} is over the upload limit for this kind of file.`]
            : []
        )
        const chosenAccounts = row.channels.length
          ? accounts
              .filter((account) => row.channels.includes(account.channel))
              .map((account) => account.id)
          : sharedAccounts
        const checked = intakeChecks(
          destinationsOf(chosenAccounts).map((account) => account.channel),
          rowFiles
        )
        return {
          files: rowFiles,
          line: row.line,
          notes: checked.notes,
          problems: [
            ...row.problems,
            ...matched.problems,
            ...tooLarge,
            ...(channelIssue ? [channelIssue] : []),
            ...checked.problems,
          ],
          input: {
            importKey: importKey(),
            caption: row.caption || expandSpintax(sharedCaption),
            media: matched.media,
            channelConnectionIds: chosenAccounts,
            ...(row.assets.length === 1 && !csv.trim() ? { sourceKey: row.assets[0] } : {}),
            timing: row.time
              ? { mode: 'time', localTime: row.time, timeZone: row.timeZone ?? zone }
              : {},
          },
        }
      })
      if (items.length + staged.length > BATCH_ITEM_LIMIT)
        throw new Error(
          `A batch holds up to ${BATCH_ITEM_LIMIT} posts; this would make ${items.length + staged.length}.`
        )
      setPreview({
        mapping,
        skipped: [],
        staged,
        unused: csv.trim() ? unusedFiles(rows, chosen) : [],
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not read this import.')
    }
  }

  const addValid = async () => {
    if (!preview) return
    const valid = preview.staged.filter((row) => row.problems.length === 0)
    if (!valid.length) return
    setBusy('add')
    try {
      const next = await call<ContentBatch>(`${base}/items`, {
        body: { items: valid.map((row) => row.input) },
        method: 'POST',
      })
      // Hold each row's own files for its attachments: two folders may share a file name.
      const added = new Map(valid.map((row) => [row.input.importKey, row]))
      for (const item of next.items ?? []) {
        const row = added.get(item.importKey)
        item.media.forEach((entry, index) => {
          const file = !entry.assetId ? row?.files[index] : undefined
          if (file) files.current.set(`${item.id}/${index}`, file)
        })
      }
      setBatch(next)
      itemsRef.current = next.items ?? []
      // Rows that were not added stay listed with their problems, so none is lost unseen.
      const left = preview.staged.filter((row) => row.problems.length > 0)
      setPreview(
        left.length ? { mapping: preview.mapping, skipped: [], staged: left, unused: [] } : null
      )
      setCSV('')
      setChosen([])
      startUploads()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The items could not be added.')
    } finally {
      setBusy(null)
    }
  }

  const reselect = (selected: File[]) => {
    for (const file of selected) {
      const names = [safeAssetFileName(file.name), storedFileName(file)]
      for (const { entry, key } of missingFiles)
        if (entry.fileName && names.includes(entry.fileName) && entry.bytes === file.size)
          files.current.set(key, file)
    }
    startUploads()
    setUploads((current) => ({ ...current }))
  }

  /** Save an item; a body given as a function is built from its latest saved state. */
  const updateItem = (
    item: BatchItem,
    body: Record<string, unknown> | ((latest: BatchItem) => Record<string, unknown>)
  ) => {
    // A new time or account set needs a new check before the item can be scheduled.
    if (typeof body === 'function' || 'timing' in body || 'channelConnectionIds' in body) {
      const stale = ([key]: [string, unknown]) => !key.startsWith(`${item.id}/`)
      setVerdicts((current) => Object.fromEntries(Object.entries(current).filter(stale)))
      setSelected((current) => Object.fromEntries(Object.entries(current).filter(stale)))
    }
    return saveItem(item.id, typeof body === 'function' ? body : () => body).then(
      () => true,
      (error: unknown) => {
        toast.error(error instanceof Error ? error.message : 'The item could not be saved.')
        return false
      }
    )
  }

  /** A post with nothing in it yet, to fill by hand. */
  const addEmptyPost = async () => {
    setBusy('add')
    try {
      const next = await call<ContentBatch>(`${base}/items`, {
        body: {
          items: [
            {
              importKey: importKey(),
              caption: '',
              media: [],
              channelConnectionIds: sharedAccounts,
              timing: {},
            },
          ],
        },
        method: 'POST',
      })
      setBatch(next)
      itemsRef.current = next.items ?? []
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The post could not be added.')
    } finally {
      setBusy(null)
    }
  }

  // Written posts, from the writing box at the end of the list: one key per
  // piece and its words, kept across tries, so a retry after a lost answer
  // gets the same posts back instead of new ones.
  const pasteKeys = React.useRef(new Map<string, string>())
  const [lastImport, setLastImport] = React.useState<{ as: PasteChoice; ids: string[] } | null>(
    null
  )
  /** Text an Undo hands back to the writing box. */
  const [restore, setRestore] = React.useState<{ as: PasteChoice; text: string } | null>(null)
  /** The row to focus once the posts just added are on the page. */
  const focusRow = React.useRef<string | null>(null)
  const room = Math.max(0, BATCH_ITEM_LIMIT - items.length)
  // A batch started for grid videos, or already holding them, leads with them, not the import.
  const gridFirst = start === 'grid' || items.some((item) => item.grid)
  // Imports lead for a batch started from files, or one already holding them; text batches lead with writing.
  const importFirst =
    !gridFirst &&
    start !== 'text' &&
    !(items.length > 0 && items.every((item) => !item.media.length && !item.grid))
  const [importing, setImporting] = React.useState(importFirst)
  const addPasted = async (captions: string[], as: PasteChoice): Promise<boolean> => {
    if (!captions.length) return false
    setBusy('add')
    try {
      const inputs = captions.map((caption, index) => {
        const at = `${index}\u0000${caption}`
        const key = pasteKeys.current.get(at) ?? importKey()
        pasteKeys.current.set(at, key)
        return { importKey: key, caption, media: [], channelConnectionIds: sharedAccounts, timing: {} }
      })
      const next = await call<ContentBatch>(`${base}/items`, {
        body: { items: inputs },
        method: 'POST',
      })
      setBatch(next)
      itemsRef.current = next.items ?? []
      const keys = new Set(inputs.map((input) => input.importKey))
      const ids = (next.items ?? []).filter((item) => keys.has(item.importKey)).map((item) => item.id)
      setLastImport({ as, ids })
      pasteKeys.current.clear()
      focusRow.current = ids[0] ?? null
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The posts could not be added.')
      return false
    } finally {
      setBusy(null)
    }
  }
  // Undo takes back the posts still not saved as drafts, and their words (as
  // the rows have them now) go back into the writing box. One that cannot be
  // removed stays, with Undo still offered for it.
  const canUndoImport =
    lastImport !== null && items.some((item) => lastImport.ids.includes(item.id) && !item.draftId)
  const undoImport = async () => {
    if (!lastImport) return
    setBusy('add')
    try {
      await settled()
      const targets = itemsRef.current.filter(
        (item) => lastImport.ids.includes(item.id) && !item.draftId
      )
      const removed: BatchItem[] = []
      for (let at = 0; at < targets.length; at += 5) {
        const results = await Promise.allSettled(
          targets.slice(at, at + 5).map((item) =>
            call(`${base}/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' }).then(
              () => item
            )
          )
        )
        for (const result of results) if (result.status === 'fulfilled') removed.push(result.value)
      }
      await reload()
      if (removed.length)
        setRestore({ as: lastImport.as, text: removed.map((item) => item.caption).join('\n---\n') })
      const left = lastImport.ids.filter((id) => !removed.some((item) => item.id === id))
      setLastImport(left.length ? { as: lastImport.as, ids: left } : null)
      if (removed.length < targets.length)
        toast.error(
          `${targets.length - removed.length} post${targets.length - removed.length === 1 ? '' : 's'} could not be removed. Try Undo again.`
        )
    } finally {
      setBusy(null)
    }
  }
  React.useEffect(() => {
    if (!focusRow.current) return
    const row = document.querySelector<HTMLElement>(`[data-item-id="${focusRow.current}"]`)
    if (!row) return
    focusRow.current = null
    row.scrollIntoView({ block: 'nearest' })
    row.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  }, [items])

  /** Swap a post with its neighbour; only rows whose place changes are sent. */
  const move = async (index: number, delta: -1 | 1) => {
    const other = index + delta
    if (other < 0 || other >= items.length) return
    const order = items.map((item) => item.id)
    ;[order[index], order[other]] = [order[other]!, order[index]!]
    const changes = order.flatMap((id, at) =>
      items.find((item) => item.id === id)?.position === at ? [] : [{ itemId: id, position: at }]
    )
    try {
      if (changes.length) await applyChanges(changes)
      focusRow.current = items[index]!.id
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The post could not be moved.')
    }
  }
  /** Join two text posts not saved yet: the next one's words follow, as a new paragraph. */
  const joinNext = async (index: number) => {
    setBusy('join')
    try {
      // A caption still being saved, such as one left by opening this menu, goes first.
      await settled()
      const [first, second] = [itemsRef.current[index], itemsRef.current[index + 1]]
      if (!first || !second || first.draftId || second.draftId) return
      replaceItem(
        await call<BatchItem>(`${base}/items/${encodeURIComponent(first.id)}`, {
          body: { caption: [first.caption, second.caption].filter(Boolean).join('\n\n') },
          method: 'PATCH',
        })
      )
      try {
        await call(`${base}/items/${encodeURIComponent(second.id)}`, { method: 'DELETE' })
      } catch {
        toast.error(
          `Post ${index + 2}'s words are now in post ${index + 1}, but post ${index + 2} could not be removed. Remove it from its menu.`
        )
      }
      await reload()
      focusRow.current = first.id
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The posts could not be joined.')
    } finally {
      setBusy(null)
    }
  }

  // A saved post's words are edited in place, on its own draft, only while
  // that draft is still the plain single post the batch made: once it has a
  // thread, media or formatting, or anything is scheduled, it opens in its
  // draft instead. Saves for one post run in turn at the version this page
  // last saved, so an edit made elsewhere is refused, never overwritten.
  const [rowErrors, setRowErrors] = React.useState<Record<string, string>>({})
  /** Posts whose time and accounts are open; the rest show one line of each. */
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({})
  /** The post open in the preview sheet, by its id. */
  const [previewing, setPreviewing] = React.useState<string | null>(null)
  const draftSaves = React.useRef(new Map<string, Promise<void>>())
  const recheck = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const busyRef = React.useRef(busy)
  busyRef.current = busy
  React.useEffect(
    () => () => {
      if (recheck.current) clearTimeout(recheck.current)
    },
    []
  )
  const saveDraftText = (item: BatchItem, text: string) => {
    const run = async () => {
      const latest = itemsRef.current.find((candidate) => candidate.id === item.id)
      if (!latest?.draftId || !latest.draft || text === latest.draft.plainText) return
      const stale = ([key]: [string, unknown]) => !key.startsWith(`${item.id}/`)
      const wasChecked = Object.keys(verdicts).length > 0
      setVerdicts((current) => Object.fromEntries(Object.entries(current).filter(stale)))
      setSelected((current) => Object.fromEntries(Object.entries(current).filter(stale)))
      setRowErrors(({ [item.id]: _dropped, ...rest }) => rest)
      try {
        const current = await draftsApi.get(latest.draftId)
        if (current.version !== latest.draft.version)
          throw new DraftRequestError('Changed elsewhere.', 409)
        if (!plainTextDraft(current.body) || current.assetIds.length) {
          setRowErrors((errors) => ({
            ...errors,
            [item.id]:
              'This draft has a thread, media or formatting now. Your words are still in the box: open the draft to edit it there.',
          }))
          return
        }
        const saved = await draftsApi.save(latest.draftId, {
          baseVersion: latest.draft.version,
          body: importedBody([text]),
          plainText: text,
        })
        const next = {
          ...latest,
          draft: { ...latest.draft, plainText: saved.plainText, version: saved.version },
        }
        itemsRef.current = itemsRef.current.map((candidate) =>
          candidate.id === item.id ? next : candidate
        )
        replaceItem(next)
        // Only this post is checked again, and its choices start from the new answer.
        if (wasChecked && canPublish) {
          if (recheck.current) clearTimeout(recheck.current)
          recheck.current = setTimeout(() => {
            if (!busyRef.current) void check([item.id])
          }, 1500)
        }
      } catch (error) {
        setRowErrors((errors) => ({
          ...errors,
          [item.id]:
            error instanceof DraftRequestError && error.status === 409
              ? 'This draft changed somewhere else, so your edit was not saved. Your words are still in the box: open the draft to combine them.'
              : error instanceof Error
                ? `Not saved: ${error.message}`
                : 'Not saved. Try again.',
        }))
      }
    }
    const next = (draftSaves.current.get(item.id) ?? Promise.resolve()).then(run, run)
    draftSaves.current.set(item.id, next)
    return next
  }

  /** Add files to a post that is not a draft yet, after what it already holds. */
  const addToItem = async (item: BatchItem, selected: File[]) => {
    const latest = itemsRef.current.find((candidate) => candidate.id === item.id) ?? item
    if (latest.media.length + selected.length > BATCH_MEDIA_LIMIT) {
      toast.error(`A post takes up to ${BATCH_MEDIA_LIMIT} attachments.`)
      return
    }
    const added = selected.map((file) => ({ bytes: file.size, fileName: storedFileName(file) }))
    if (added.some((entry) => !entry.fileName || !entry.bytes)) {
      toast.error('Rename files with no letters or digits, and leave out empty ones.')
      return
    }
    const at = latest.media.length
    await updateItem(latest, (current) => ({
      media: [...current.media.map(mediaInput), ...added],
    }))
    selected.forEach((file, index) => files.current.set(`${item.id}/${at + index}`, file))
    startUploads()
  }

  const applySharedAccounts = async () => {
    setBusy('accounts')
    for (const item of items) {
      if (!item.draftId) await updateItem(item, { channelConnectionIds: sharedAccounts })
    }
    setBusy(null)
  }

  /** Change many items as one operation; a refusal leaves every item as it was. */
  const applyChanges = async (changes: ({ itemId: string } & Record<string, unknown>)[]) => {
    setBusy('bulk')
    try {
      await settled()
      const next = await call<ContentBatch>(`${base}/items`, {
        body: { items: changes },
        method: 'PATCH',
      })
      setBatch(next)
      itemsRef.current = next.items ?? []
    } finally {
      setBusy(null)
    }
  }

  const applyCaptions = async (changes: { caption: string; itemId: string }[]) => {
    try {
      await applyChanges(changes)
      toast.success(`${changes.length} caption${changes.length === 1 ? '' : 's'} applied.`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The captions could not be applied.')
    }
  }

  const applyGrids = async (changes: ({ itemId: string } & Record<string, unknown>)[]) => {
    try {
      await applyChanges(changes)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The videos could not be changed.')
    }
  }

  /** Stage grid concepts as posts. */
  const addConcepts = async (inputs: BatchItemInput[]) => {
    setBusy('add')
    try {
      const next = await call<ContentBatch>(`${base}/items`, {
        body: { items: inputs },
        method: 'POST',
      })
      setBatch(next)
      itemsRef.current = next.items ?? []
    } finally {
      setBusy(null)
    }
  }

  const [gridOpen, setGridOpen] = React.useState(start === 'grid')
  const showGrid = gridOpen || items.some((item) => item.grid)

  const [timeValidity, setTimeValidity] = React.useState<Record<string, boolean>>({})
  const [spreadValid, setSpreadValid] = React.useState(true)
  const [timingRevision, setTimingRevision] = React.useState<Record<string, number>>({})
  const hasInvalidTimes = items.some((item) => timeValidity[item.id] === false)
  const [timesMode, setTimesMode] = React.useState<'queue' | 'hourly' | 'spread'>('queue')
  const [spread, setSpread] = React.useState({ start: '', perDay: 2, spacing: 240, shift: 0 })
  // Every hour, from a start to an end of day; posts past the end continue the next day at the start time.
  const [hourly, setHourly] = React.useState({ start: '', until: '17:00' })
  const [hourlyValid, setHourlyValid] = React.useState(true)
  React.useEffect(() => {
    const tomorrow = wallTime(new Date(Date.now() + 86_400_000), zone).slice(0, 10)
    setHourly((current) => (current.start ? current : { ...current, start: `${tomorrow}T09:00` }))
  }, [zone])
  const hourlyDay = hourlyWindow(hourly.start.slice(11, 16), hourly.until)
  const planReady =
    timesMode === 'spread'
      ? spreadValid
      : timesMode === 'hourly'
        ? hourlyValid && hourlyDay !== null
        : true
  const [seed] = React.useState(() => crypto.randomUUID())
  const planTimes = async () => {
    if (!planReady) return
    // Items with nothing scheduled yet on some account, or no accounts chosen yet.
    const targets = itemsRef.current.filter((item) => {
      const ids = itemAccounts(item)
      return !ids.length || pendingAccounts(item, ids).remaining.length > 0
    })
    if (!targets.length) {
      toast.info('Every item is already scheduled on its accounts.')
      return
    }
    setBusy('times')
    try {
      const { times } = await call<{ times: string[] }>('/api/v1/content-draft-batch/times', {
        method: 'POST',
        body:
          timesMode === 'queue'
            ? { socialSetId: batch.socialSetId, count: targets.length, mode: 'queue', seed }
            : timesMode === 'hourly'
              ? {
                  socialSetId: batch.socialSetId,
                  count: targets.length,
                  mode: 'spread',
                  localTime: hourly.start,
                  postsPerDay: hourlyDay ?? 1,
                  spacingMinutes: 60,
                  shiftMinutes: 0,
                  seed,
                }
              : {
                  socialSetId: batch.socialSetId,
                  count: targets.length,
                  mode: 'spread',
                  localTime: spread.start,
                  postsPerDay: spread.perDay,
                  spacingMinutes: spread.spacing,
                  shiftMinutes: spread.shift,
                  seed,
                },
      })
      const timings = timesMode === 'queue' ? queueTimings(times) : spreadTimings(times, zone)
      // One change for every proposed time; a refusal leaves every post as it was.
      await applyChanges(targets.map((item, index) => ({ itemId: item.id, timing: timings[index] })))
      const planned = new Set(targets.map((item) => item.id))
      const stale = ([key]: [string, unknown]) => !planned.has(key.slice(0, key.lastIndexOf('/')))
      setVerdicts((current) => Object.fromEntries(Object.entries(current).filter(stale)))
      setSelected((current) => Object.fromEntries(Object.entries(current).filter(stale)))
      // A deliberate bulk replacement also resets a time field whose valid value is unchanged.
      setTimingRevision((current) =>
        Object.fromEntries([
          ...Object.entries(current),
          ...targets.map((item) => [item.id, (current[item.id] ?? 0) + 1]),
        ])
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The times could not be planned.')
    } finally {
      setBusy(null)
    }
  }

  // Drafts: each finished item becomes its own draft; a retry returns the same one.
  const saveDrafts = async () => {
    if (hasInvalidTimes) return toast.error('Correct the invalid times before continuing.')
    setBusy('drafts')
    // An edit still being saved, such as a caption left by clicking here, goes first.
    await settled()
    let failed = 0
    for (const item of itemsRef.current) {
      if (item.draftId || item.media.some((entry) => !entry.assetId) || waitingToRender(item))
        continue
      try {
        const body = stagedBody(item)
        const channels = accounts
          .filter((account) => item.channelConnectionIds.includes(account.id))
          .map((account) => account.channel)
        const platformVersions = stagedVersions(item, channels, videoOptions)
        replaceItem(
          await call<BatchItem>(`${base}/items/${encodeURIComponent(item.id)}/draft`, {
            method: 'POST',
            body: {
              title:
                item.caption.trim().split('\n')[0].slice(0, 80) ||
                item.media[0]?.fileName ||
                'Batch post',
              body,
              plainText: item.caption,
              assetIds: item.media.map((entry) => entry.assetId!),
              ...(platformVersions ? { platformVersions } : {}),
            },
          })
        )
      } catch (error) {
        failed += 1
        toast.error(error instanceof Error ? error.message : 'A draft could not be saved.')
      }
    }
    setBusy(null)
    if (failed)
      toast.error(
        `${failed} item${failed === 1 ? '' : 's'} could not be saved; the rest are drafts.`
      )
  }

  const requestReviews = async () => {
    setBusy('review')
    // A draft that could not go to review says why on its item; the others still go.
    const failed: Record<string, string> = {}
    for (const item of items) {
      if (
        !item.draftId ||
        item.draft?.reviewStatus === 'approved' ||
        item.draft?.reviewStatus === 'pending'
      )
        continue
      if (!item.draft) {
        failed[item.id] = 'Review not requested: reload this draft and try again.'
        continue
      }
      await draftsApi
        .review(item.draftId, { action: 'request', version: item.draft.version })
        .catch((error: unknown) => {
          failed[item.id] =
            `Review not requested: ${error instanceof Error ? error.message : 'try again.'}`
        })
    }
    setOutcomes((current) => ({ ...current, ...failed }))
    const count = Object.keys(failed).length
    if (count) toast.error(`${count} draft${count === 1 ? '' : 's'} could not be sent for review.`)
    await reload()
    setBusy(null)
  }

  // Checking and scheduling: every item and account apart, chosen explicitly.
  const [verdicts, setVerdicts] = React.useState<Record<string, BatchValidation>>({})
  const [selected, setSelected] = React.useState<Record<string, boolean>>({})
  const [outcomes, setOutcomes] = React.useState<Record<string, string>>(() =>
    runOutcomes(initial.submission)
  )
  /** Scheduled posts left this month, read when the batch is checked. Go's charge decides. */
  const [postsLeft, setPostsLeft] = React.useState<number | null>(null)
  const verdictKey = (itemId: string, accountId: string) => `${itemId}/${accountId}`
  /**
   * Check every post on each of its accounts, or only `only`'s posts after
   * an edit: then the other posts' answers and choices stay as they were, and
   * the checked post's choices start from its new answer.
   */
  const check = async (only?: readonly string[]) => {
    if (hasInvalidTimes) return toast.error('Correct the invalid times before continuing.')
    setBusy('check')
    try {
      // The server checks each item's stored time, so edits on their way land first.
      await settled()
      const requests = itemsRef.current
        .filter((item) => !only || only.includes(item.id))
        .flatMap((item) => {
          const { remaining } = pendingAccounts(item, itemAccounts(item))
          return remaining.length ? [{ itemId: item.id, channelConnectionIds: remaining }] : []
        })
      if (!requests.length) {
        if (only) return
        setVerdicts({})
        toast.info(
          'No saved draft has an account left to schedule. Choose accounts on the items, then save them as drafts.'
        )
        return
      }
      // Each account's media is prepared for the check, so a full batch goes in parts.
      const results: BatchValidation[] = []
      for (let at = 0; at < requests.length; at += VALIDATE_CHUNK) {
        const part = await call<{ results: BatchValidation[] }>(`${base}/validate`, {
          body: { items: requests.slice(at, at + VALIDATE_CHUNK) },
          method: 'POST',
        })
        results.push(...part.results)
      }
      // A time the browser reads differently (a skipped hour) is the item's problem too.
      const next: Record<string, BatchValidation> = {}
      for (const result of results)
        next[verdictKey(result.itemId, result.channelConnectionId)] = result
      const chosen = Object.fromEntries(
        results.map((result) => [verdictKey(result.itemId, result.channelConnectionId), result.valid])
      )
      if (only) {
        const outside = ([key]: [string, unknown]) =>
          !only.includes(key.slice(0, key.lastIndexOf('/')))
        setVerdicts((current) => ({
          ...Object.fromEntries(Object.entries(current).filter(outside)),
          ...next,
        }))
        setSelected((current) => ({
          ...Object.fromEntries(Object.entries(current).filter(outside)),
          ...chosen,
        }))
        return
      }
      setVerdicts(next)
      setPostsLeft(
        await trpc.billing.summary.query().then(
          ({ posts }) => posts.left,
          () => null
        )
      )
      setSelected(chosen)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The batch could not be checked.')
    } finally {
      setBusy(null)
    }
  }
  /**
   * The batch's one planning step: posts not saved yet become drafts, each is
   * given a proposed time, and every post and account is checked. Nothing is
   * scheduled; each part reports its own failure and can be run again alone.
   */
  const planAll = async () => {
    if (hasInvalidTimes) return toast.error('Correct the invalid times before continuing.')
    await saveDrafts()
    await planTimes()
    if (canPublish) await check()
  }
  const chosenCount = Object.entries(selected).filter(
    ([key, on]) => on && verdicts[key]?.valid
  ).length
  const chosenPosts = new Set(
    Object.entries(selected)
      .filter(([key, on]) => on && verdicts[key]?.valid)
      .map(([key]) => key.slice(0, key.lastIndexOf('/')))
  ).size
  const attention = Object.values(verdicts).filter((verdict) => !verdict.valid).length

  /** A submit with no answer yet: trying again sends the same key, which replays it. */
  const unanswered = React.useRef<{
    items: { channelConnectionIds: string[]; itemId: string }[]
    requestKey: string
  } | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  /** Show a schedule's progress until it is done; it carries on whether or not anyone watches. */
  const follow = React.useCallback(
    async (started: BatchRun) => {
      setSubmitting(true)
      try {
        let run = started
        setOutcomes(runOutcomes(run))
        while (run.status === 'RUNNING') {
          await new Promise((resolve) => setTimeout(resolve, SUBMIT_POLL_MS))
          run = await call<BatchRun>(`${base}/runs/${encodeURIComponent(run.id)}`)
          setOutcomes(runOutcomes(run))
        }
        await reload()
        setVerdicts({})
        setSelected({})
      } catch {
        toast.info('Scheduling continues in the background. Reload this page to see its progress.')
      } finally {
        setSubmitting(false)
      }
    },
    [base, reload]
  )

  const schedule = async () => {
    if (hasInvalidTimes) return toast.error('Correct the invalid times before continuing.')
    setBusy('schedule')
    try {
      // Each item schedules at its saved time: a time changed since the check dropped its verdicts.
      await settled()
      const request = unanswered.current ?? {
        requestKey: `submit-${crypto.randomUUID()}`,
        items: itemsRef.current.flatMap((item) => {
          const channelConnectionIds = Object.entries(selected)
            .filter(([key, on]) => on && key.startsWith(`${item.id}/`) && verdicts[key]?.valid)
            .map(([key]) => key.slice(item.id.length + 1))
          return item.draftId && channelConnectionIds.length
            ? [{ channelConnectionIds, itemId: item.id }]
            : []
        }),
      }
      unanswered.current = request
      const run = await call<BatchRun>(`${base}/submit`, { body: request, method: 'POST' })
      unanswered.current = null
      await follow(run)
    } catch (error) {
      // A refusal needs a correction; only an unanswered request is sent again as it was.
      if (error instanceof DraftRequestError && error.status < 500) unanswered.current = null
      toast.error(error instanceof Error ? error.message : 'The batch could not be scheduled.')
    } finally {
      setBusy(null)
    }
  }

  // A schedule that outlived the last visit to this page is picked up again.
  React.useEffect(() => {
    if (initial.submission?.status === 'RUNNING') void follow(initial.submission)
  }, [follow, initial.submission])

  const archive = async () => {
    await call(`${base}/archive`, { method: 'POST' })
    window.location.assign('/publish')
  }

  const accountName = (id: string) =>
    accounts.find((account) => account.id === id)?.name ?? 'Removed account'
  const summary = batchSummary(items, zone)
  // "X @founder" for a batch on one account, else how many posts go to how many accounts.
  const batchAccountIds = [...new Set(items.flatMap(itemAccounts))]
  const audience =
    batchAccountIds.length === 1
      ? destinationsOf(batchAccountIds)
          .map((account) => `${CHANNEL_META[account.channel].label} ${destinationName(account)}`)
          .join('')
      : batchAudience(items, accounts)
  // Formatted day by day, as `when` formats, so the server's text matches the browser's.
  const day = (at: Date) =>
    at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: zone })
  const range =
    summary.first && summary.last
      ? [...new Set([day(summary.first), day(summary.last)])].join(' – ')
      : null
  const unsaved = items.filter((item) => !item.draftId)
  const unsavedAccounts = accounts.filter((account) =>
    unsaved.some((item) => item.channelConnectionIds.includes(account.id))
  )
  const videoChannels = (['youtube', 'tiktok'] as const).flatMap((channel) => {
    const account = unsavedAccounts.find((candidate) => candidate.channel === channel)
    return account ? [{ channel, creator: account.tiktokCreator }] : []
  })
  const ready = unsaved.filter(
    (item) => item.media.every((entry) => entry.assetId) && !waitingToRender(item)
  )
  const notRendered = items.filter(waitingToRender).length
  const drafted = items.filter((item) => item.draftId)
  const checked = Object.keys(verdicts).length > 0
  // Smaller action buttons on phones, where the bar stays over the posts.
  const compact = useIsMobile() ? 'sm' : 'default'
  const gridCreator = showGrid ? (
    <GridCreator
      disabled={busy !== null}
      base={base}
      items={items}
      lastRender={batch.render}
      sharedAccounts={sharedAccounts}
      onAdd={addConcepts}
      onApply={applyGrids}
      onReload={reload}
      onUpdate={updateItem}
    />
  ) : null

  return (
    <Page
      title={batch.title}
      description={
        <>
          Each post becomes its own draft. Times in {zone}. Saved as you go.
        </>
      }
      actions={
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button aria-label="Change accounts" variant="outline">
                {sharedAccounts.length === 1 ? (
                  <DestinationSummary accounts={destinationsOf(sharedAccounts)} />
                ) : (
                  `${sharedAccounts.length} accounts`
                )}
                <CaretDownIcon aria-hidden className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel>New posts go to</DropdownMenuLabel>
              {accounts.length ? (
                accounts.map((account) => (
                  <DropdownMenuCheckboxItem
                    checked={sharedAccounts.includes(account.id)}
                    key={account.id}
                    onCheckedChange={(checked) =>
                      setSharedAccounts((current) =>
                        checked === true
                          ? [...current, account.id]
                          : current.filter((id) => id !== account.id)
                      )
                    }
                    // Several accounts are chosen in one visit.
                    onSelect={(event) => event.preventDefault()}
                  >
                    <ChannelIcon channel={account.channel} />
                    {CHANNEL_META[account.channel].label}
                    <span className="truncate text-muted-foreground">
                      {destinationName(destinationsOf([account.id])[0]!)}
                    </span>
                  </DropdownMenuCheckboxItem>
                ))
              ) : (
                <DropdownMenuItem asChild>
                  <Link href="/settings/publishing-brands">Connect an account</Link>
                </DropdownMenuItem>
              )}
              {unsaved.length ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={busy !== null}
                    onSelect={() => void applySharedAccounts()}
                  >
                    Apply to posts not saved yet
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Wide screens always show the import beside the posts. */}
          <Button
            aria-expanded={importing}
            className="xl:hidden"
            onClick={() => setImporting((open) => !open)}
            variant={importing ? 'secondary' : 'outline'}
          >
            <UploadIcon aria-hidden />
            Import
          </Button>
          <Button
            variant="ghost"
            disabled={busy !== null}
            onClick={() => {
              if (
                window.confirm('Close this batch? Its drafts and scheduled posts stay in Publish.')
              )
                void archive()
            }}
          >
            Close batch
          </Button>
        </>
      }
    >
      {missingFiles.length > 0 ? (
        <Alert role="status">
          <UploadIcon />
          <AlertTitle>
            {missingFiles.length} file{missingFiles.length === 1 ? '' : 's'} did not finish
            uploading before the page closed
          </AlertTitle>
          <AlertDescription className="grid gap-3">
            <p>
              {[...new Set(missingFiles.map(({ entry }) => entry.fileName))].join(', ')}. Select
              the same files again to continue; large files resume where they stopped, and nothing
              else is lost.
            </p>
            <FilePicker
              accept={ACCEPT}
              label="Select the files again"
              multiple
              onFiles={reselect}
            />
            <FilePicker
              accept={IMAGE_ACCEPT}
              directory
              label="Select the folder again"
              multiple
              onFiles={reselect}
            />
          </AlertDescription>
        </Alert>
      ) : null}

      <div
        className="grid w-full grid-cols-[minmax(0,1fr)] items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:gap-8"
        data-testid="bulk-batch"
      >
        {/* Adding posts, and settings for all of them: first on phones, beside the posts on wide screens. */}
        <aside
          aria-label="Batch tools"
          className={cn(
            'grid min-w-0 content-start gap-6 xl:sticky xl:top-6 xl:col-start-2 xl:row-start-1 xl:overflow-y-auto',
            // The save bar, once there are posts, stays clear of the rail's last rows.
            items.length ? 'xl:max-h-[calc(100dvh-18rem)]' : 'xl:max-h-[calc(100dvh-5rem)]',
            !importing && !videoChannels.length && 'max-xl:hidden'
          )}
        >
          <div className={cn('grid gap-6', !importing && 'max-xl:hidden')}>
            <Section title="Add posts" description="Nothing is added until you review the preview.">
              <Group>
                <div className="grid gap-3 p-4">
                  <div
                    {...dropzone.getRootProps({
                      className: cn(
                        'grid justify-items-center gap-3 rounded-lg border border-dashed border-border px-4 py-7 text-center transition-colors',
                        dropzone.isDragActive && 'border-primary bg-muted'
                      ),
                    })}
                  >
                    <UploadIcon aria-hidden className="size-5 text-muted-foreground" />
                    <p className="text-ui font-medium text-foreground">
                      {dropzone.isDragActive
                        ? 'Drop to add'
                        : start === 'videos'
                          ? 'Drop videos here'
                          : start === 'images'
                            ? 'Drop image folders here'
                            : 'Drop files or folders here'}
                    </p>
                    <div className="flex flex-wrap justify-center gap-2">
                      {start !== 'images' ? (
                        <FilePicker
                          accept={start === 'videos' ? VIDEO_ACCEPT : ACCEPT}
                          label="Batch media files"
                          multiple
                          onFiles={setChosen}
                        >
                          {start === 'videos' ? 'Choose videos' : 'Choose files'}
                        </FilePicker>
                      ) : null}
                      {start !== 'videos' ? (
                        <FilePicker
                          accept={IMAGE_ACCEPT}
                          directory
                          label="Batch image folder"
                          multiple
                          onFiles={setChosen}
                        >
                          Choose a folder
                        </FilePicker>
                      ) : null}
                    </div>
                    <p className="text-label text-pretty text-muted-foreground">
                      {chosen.length
                        ? `${chosen.length} file${chosen.length === 1 ? '' : 's'} · ${megabytes(chosen.reduce((sum, file) => sum + file.size, 0))}`
                        : start === 'videos'
                          ? 'MP4, MOV or WebM. Each video becomes one post.'
                          : start === 'images'
                            ? 'JPEG, PNG, WebP or GIF. A folder becomes one post; a parent folder makes one per subfolder.'
                            : 'Images, videos, and PDFs for LinkedIn. Each file becomes one post; a folder of images becomes one.'}
                    </p>
                  </div>
                  {start !== 'videos' && (folderChosen || start === 'images') ? (
                    <Label className="justify-self-center font-normal">
                      <Checkbox
                        checked={perImage}
                        onCheckedChange={(checked) => setPerImage(checked === true)}
                      />
                      One post per image
                    </Label>
                  ) : null}
                  <div className="flex flex-wrap justify-center gap-x-4 gap-y-1">
                    <Button
                      className="h-auto p-0 text-label text-muted-foreground hover:text-foreground"
                      disabled={busy !== null}
                      onClick={() => void addEmptyPost()}
                      type="button"
                      variant="link"
                    >
                      Add an empty post
                    </Button>
                    {!showGrid ? (
                      <Button
                        className="h-auto p-0 text-label text-muted-foreground hover:text-foreground"
                        onClick={() => {
                          setGridOpen(true)
                          // The click commits the creator before the next frame.
                          requestAnimationFrame(() => reveal(gridRef.current))
                        }}
                        type="button"
                        variant="link"
                      >
                        Create grid videos
                      </Button>
                    ) : null}
                  </div>
                </div>
                <Disclosure>
                  <DisclosureTrigger
                    className="px-4 py-3 text-ui text-foreground focus-visible:ring-inset"
                    summary={csv.trim() ? 'Added' : 'Optional'}
                  >
                    From a CSV
                  </DisclosureTrigger>
                  <DisclosureContent className="grid gap-2 px-4 pb-4">
                    <p className="text-label text-pretty text-muted-foreground">
                      Columns: <code>caption</code>, <code>asset</code>, <code>channels</code>,{' '}
                      <code>time</code> and <code>timezone</code>. An asset is a file name or a
                      workspace asset ID; separate several with <code>;</code>. Rows match files by
                      their exact name.
                    </p>
                    <Textarea
                      aria-label="Batch CSV"
                      rows={4}
                      value={csv}
                      placeholder={
                        'caption,asset,channels,time\n"Launch day, finally",hero.png,x;linkedin,2026-11-03 09:30'
                      }
                      onChange={(event) => setCSV(event.target.value)}
                      className="font-mono text-xs"
                    />
                    <div>
                      <FilePicker
                        accept=".csv,text/csv"
                        label="Batch CSV file"
                        onFiles={([file]) => {
                          if (file && file.size <= 1_000_000) void file.text().then(setCSV)
                          else if (file) toast.error('CSV files must be smaller than 1 MB.')
                        }}
                      >
                        Load a CSV file
                      </FilePicker>
                    </div>
                  </DisclosureContent>
                </Disclosure>
                <Disclosure>
                  <DisclosureTrigger
                    className="px-4 py-3 text-ui text-foreground focus-visible:ring-inset"
                    summary={sharedCaption.trim() ? 'Added' : 'Optional'}
                  >
                    Shared caption
                  </DisclosureTrigger>
                  <DisclosureContent className="grid gap-2 px-4 pb-4">
                    <p className="text-label text-pretty text-muted-foreground">
                      For posts whose row or file has no caption. <code>{'{Hello|Hi}'}</code> gives
                      each post its own variation.
                    </p>
                    <Textarea
                      aria-label="Shared caption"
                      rows={2}
                      value={sharedCaption}
                      onChange={(event) => setSharedCaption(event.target.value)}
                    />
                  </DisclosureContent>
                </Disclosure>
                <div className="flex justify-end px-4 py-3">
                  <Button
                    disabled={!chosen.length && !csv.trim()}
                    onClick={() => void previewImport()}
                    size="sm"
                  >
                    Preview import
                  </Button>
                </div>
              </Group>
            </Section>
            <BulkCaptionPanel
              accounts={accounts}
              disabled={busy !== null}
              items={items}
              onApply={applyCaptions}
            />
          </div>
          {videoChannels.length ? (
            <Section
              title="Video options"
              description={`YouTube and TikTok need these. They apply to the ${unsaved.length} post${unsaved.length === 1 ? '' : 's'} not saved as drafts yet. An empty YouTube title uses each post's first caption line, or its file name.`}
            >
              {videoChannels.map(({ channel, creator }) => (
                <Group key={channel}>
                  <VideoOptions
                    channel={channel}
                    creator={creator}
                    disabled={busy !== null}
                    options={videoOptions}
                    onChange={setVideoOptions}
                  />
                </Group>
              ))}
            </Section>
          ) : null}
        </aside>

        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 xl:col-start-1 xl:row-start-1">
          {gridCreator ? (
            <div className="scroll-mt-6 outline-none" ref={gridRef} tabIndex={-1}>
              {gridCreator}
            </div>
          ) : null}

          {preview ? (
            <div
              className="scroll-mt-6 outline-none"
              data-testid="import-preview"
              ref={previewRef}
              tabIndex={-1}
            >
              <Section title="Review the import">
                {preview.mapping ? (
                  <p className="text-xs text-muted-foreground">
                    Columns:{' '}
                    {preview.mapping
                      .map((column) => `${column.header} → ${column.field ?? 'ignored'}`)
                      .join(' · ')}
                  </p>
                ) : null}
                {preview.staged.every((row) => row.problems.length) ? (
                  <p className="text-xs text-muted-foreground">
                    These rows were not added. Fix them in the CSV, select any missing files, and
                    preview again.
                  </p>
                ) : null}
                {preview.unused.length ? (
                  <p className="text-xs text-muted-foreground">
                    Not used by any row: {preview.unused.join(', ')}
                  </p>
                ) : null}
                {preview.skipped.length ? (
                  <p className="text-xs text-muted-foreground" data-testid="import-skipped">
                    Skipped:{' '}
                    {preview.skipped.map((entry) => `${entry.name} (${entry.reason})`).join(', ')}
                  </p>
                ) : null}
                <ImportReview accountName={accountName} rows={preview.staged} />
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={
                      busy !== null || !preview.staged.some((row) => !row.problems.length)
                    }
                    onClick={() => void addValid()}
                  >
                    Add {preview.staged.filter((row) => !row.problems.length).length} ready rows
                    {preview.staged.some((row) => row.problems.length)
                      ? ` (${preview.staged.filter((row) => row.problems.length).length} need fixing first)`
                      : ''}
                  </Button>
                  <Button
                    disabled={busy !== null}
                    variant="ghost"
                    onClick={() => setPreview(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </Section>
            </div>
          ) : null}

          <Section
            title="Posts"
            description={
              items.length
                ? `${items.length} post${items.length === 1 ? '' : 's'} in this batch.`
                : 'No posts yet. Write one below or add files.'
            }
            actions={
              items.length ? (
                <Button onClick={() => setPreviewing(items[0]!.id)} size="sm" variant="outline">
                  <EyeIcon aria-hidden />
                  Preview posts
                </Button>
              ) : null
            }
          >
            {/* The posts read as Write shows a post: who it goes out as, its words,
                its length and when it is planned. The writing box ends the list. */}
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {items.length ? (
                <ol aria-label="Batch items" className="divide-y divide-border">
                  {items.map((item, index) => {
                    const timing = readTiming(item.timing)
                    const accountIds = itemAccounts(item)
                    const staged = stagedChecks(item, accounts)
                    const status = itemStatus(item)
                    const channel = itemChannel(item)
                    const length = captionLength(item)
                    const remaining = pendingAccounts(item, accountIds).remaining
                    const live =
                      accountIds.length > 0 && remaining.length === 0
                        ? accountIds.map((id) => postOn(item, id)).find(Boolean)
                        : undefined
                    const planned = plannedText(item, zone)
                    const problems = accountIds.flatMap((id) => {
                      const verdict = verdicts[verdictKey(item.id, id)]
                      if (verdict) return verdict.valid ? [] : [verdict.error]
                      return staged.get(id)?.problems ?? []
                    })
                    const checks = accountIds.map((id) => verdicts[verdictKey(item.id, id)])
                    const ready =
                      accountIds.length > 0 && checks.every((verdict) => verdict?.valid === true)
                    const text = item.draft?.plainText ?? item.caption
                    // A saved text post is edited here, on its draft; one with media or a
                    // live post opens in its draft.
                    const editsDraft = Boolean(
                      item.draftId &&
                        item.draft &&
                        !item.media.length &&
                        !item.grid &&
                        !hasLivePosts(item.posts)
                    )
                    const author = destinationsOf(accountIds)[0]
                    const otherAccounts = accounts.filter((account) => !accountIds.includes(account.id))
                    const open = Boolean(expanded[item.id])
                    const next = items[index + 1]
                    return (
                      <li
                        key={item.id}
                        className="group/post relative grid grid-cols-[minmax(0,1fr)] gap-2 py-5 pe-4 ps-14 sm:ps-16"
                        data-item-id={item.id}
                        data-testid="batch-item"
                        // Alt+Up and Alt+Down move between posts without leaving the keyboard.
                        onKeyDown={(event) => {
                          if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown'))
                            return
                          const target = items[index + (event.key === 'ArrowUp' ? -1 : 1)]
                          if (!target) return
                          event.preventDefault()
                          document
                            .querySelector<HTMLElement>(
                              `[data-item-id="${target.id}"] textarea, [data-item-id="${target.id}"] [data-row-focus]`
                            )
                            ?.focus()
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <div className="min-w-0 flex-1">
                            <PostAuthor
                              avatarUrl={author?.avatarUrl}
                              channel={author?.channel ?? channel}
                              handle={author?.handle}
                              name={author?.displayName ?? author?.handle ?? 'No account chosen'}
                            />
                          </div>
                          <span className="shrink-0 text-label tabular-nums text-muted-foreground">
                            {index + 1}
                          </span>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                aria-label={`More for post ${index + 1}`}
                                className="text-muted-foreground"
                                size="icon-sm"
                                variant="ghost"
                              >
                                <MoreIcon />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onSelect={() => setExpanded((current) => ({ ...current, [item.id]: true }))}
                              >
                                Change time or accounts
                              </DropdownMenuItem>
                              {item.draftId ? (
                                <DropdownMenuItem asChild>
                                  <a href={`/publish/${item.draftId}`} rel="noreferrer" target="_blank">
                                    Open draft in a new tab
                                  </a>
                                </DropdownMenuItem>
                              ) : null}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                disabled={index === 0 || busy !== null}
                                onSelect={() => void move(index, -1)}
                              >
                                Move up
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                disabled={index === items.length - 1 || busy !== null}
                                onSelect={() => void move(index, 1)}
                              >
                                Move down
                              </DropdownMenuItem>
                              {!item.draftId &&
                              !item.grid &&
                              !item.media.length &&
                              next &&
                              !next.draftId &&
                              !next.grid &&
                              !next.media.length ? (
                                <DropdownMenuItem
                                  disabled={busy !== null}
                                  onSelect={() => void joinNext(index)}
                                >
                                  Join with the next post
                                </DropdownMenuItem>
                              ) : null}
                              {item.draftId ? null : (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    variant="destructive"
                                    onSelect={() =>
                                      void call(`${base}/items/${encodeURIComponent(item.id)}`, {
                                        method: 'DELETE',
                                      }).then(reload, (error: unknown) =>
                                        toast.error(
                                          error instanceof Error
                                            ? error.message
                                            : 'The post was not removed.'
                                        )
                                      )
                                    }
                                  >
                                    <DeleteIcon aria-hidden />
                                    Remove post {index + 1}
                                  </DropdownMenuItem>
                                </>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        {editsDraft ? (
                          <Textarea
                            key={item.id}
                            aria-label={`Caption for item ${index + 1}`}
                            className={POST_TEXT}
                            data-slot="post-text"
                            defaultValue={text}
                            onBlur={(event) => void saveDraftText(item, event.target.value)}
                          />
                        ) : item.draftId || item.grid ? (
                          <p className="draft-prose whitespace-pre-wrap text-body" data-row-focus tabIndex={-1}>
                            {text || (item.grid ? 'Grid video' : 'No caption')}
                          </p>
                        ) : (
                          <Textarea
                            // A bulk caption replaces what this box first showed.
                            key={item.caption}
                            aria-label={`Caption for item ${index + 1}`}
                            className={POST_TEXT}
                            data-slot="post-text"
                            defaultValue={item.caption}
                            placeholder="Write the post"
                            onBlur={(event) => {
                              if (event.target.value !== item.caption)
                                void updateItem(item, { caption: event.target.value })
                            }}
                          />
                        )}
                        {item.media.length ? (
                          <ul className="flex flex-wrap content-start gap-2">
                            {item.media.map((entry, at) => (
                              <MediaTile
                                key={`${entry.assetId ?? entry.fileName}-${at}`}
                                entry={entry}
                                file={files.current.get(`${item.id}/${at}`)}
                                upload={uploads[`${item.id}/${at}`]}
                                onRetry={() => retryUpload(item.id, at)}
                              />
                            ))}
                          </ul>
                        ) : null}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                          <PostCount
                            active={open}
                            channel={channel}
                            length={length}
                            limit={CAPABILITIES[channel].captionLimit}
                            number={index + 1}
                            thread={false}
                          />
                          {accountIds.length > 1 ? (
                            <DestinationSummary accounts={destinationsOf(accountIds)} />
                          ) : null}
                          <Button
                            aria-expanded={open}
                            className={cn(
                              'inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-label',
                              timing.kind === 'problem' && !live
                                ? 'border-destructive/40 text-destructive'
                                : 'border-border text-muted-foreground hover:text-foreground'
                            )}
                            data-testid={`batch-item-time-${index + 1}`}
                            onClick={() => setExpanded((current) => ({ ...current, [item.id]: !open }))}
                            size={null}
                            title="Change time or accounts"
                            variant="custom"
                          >
                            <CalendarIcon aria-hidden className="size-3.5" />
                            {planned}
                          </Button>
                          {/* A plain saved draft says so through Open draft; other states are named. */}
                          {status.text === 'Draft' ? null : <Pill tone={status.tone}>{status.text}</Pill>}
                          {problems.length ? (
                            <Pill tone="red">Needs attention</Pill>
                          ) : ready ? (
                            <Pill tone="green">Ready</Pill>
                          ) : null}
                          <Button
                            aria-label={`Preview post ${index + 1}`}
                            className="inline-flex items-center gap-1 text-label text-muted-foreground hover:text-foreground"
                            onClick={() => setPreviewing(item.id)}
                            size={null}
                            variant="custom"
                          >
                            <EyeIcon aria-hidden className="size-3.5" />
                            Preview
                          </Button>
                          {item.draftId ? (
                            <a
                              className="inline-flex items-center gap-1 text-label text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                              href={`/publish/${item.draftId}`}
                              rel="noreferrer"
                              target="_blank"
                            >
                              Open draft
                              <OutwardIcon aria-hidden className="size-3" />
                            </a>
                          ) : null}
                        </div>
                        {problems.length ? (
                          <p className="text-label text-destructive">{problems[0]}</p>
                        ) : null}
                        {rowErrors[item.id] ? (
                          <p className="text-label text-destructive" role="alert">
                            {rowErrors[item.id]}
                          </p>
                        ) : null}
                        {open ? (
                          <div className="mt-1 grid gap-3 rounded-lg border border-border bg-foreground/[0.02] p-3 text-sm">
                            <p className="text-label font-medium text-foreground">Time</p>
                            <p className="-mt-2 text-label text-muted-foreground">
                              {item.timing.mode === 'queue' && timing.kind === 'at'
                                ? `In the next queue slot, ${shortWhen(timing.at, zone)}. To set an exact time instead (${zone}):`
                                : `Time (${item.timing.timeZone || zone})`}
                            </p>
                            <div className="flex flex-wrap items-center gap-2">
                              <LocalTimeFields
                                key={timingRevision[item.id] ?? 0}
                                disabled={busy !== null}
                                onValidityChange={(valid) =>
                                  setTimeValidity((current) =>
                                    current[item.id] === valid
                                      ? current
                                      : { ...current, [item.id]: valid }
                                  )
                                }
                                label={`Item ${index + 1}`}
                                value={item.timing.mode === 'time' ? (item.timing.localTime ?? '') : ''}
                                onChange={(edit) =>
                                  void updateItem(item, (latest) => ({
                                    timing: {
                                      mode: 'time',
                                      localTime: edit(
                                        latest.timing.mode === 'time'
                                          ? (latest.timing.localTime ?? '')
                                          : ''
                                      ),
                                      timeZone: latest.timing.timeZone || zone,
                                    },
                                  }))
                                }
                              />
                              {timing.kind === 'problem' && /happens twice/.test(timing.text)
                                ? (['earlier', 'later'] as const).map((choice) => (
                                    <Button
                                      key={choice}
                                      disabled={busy !== null}
                                      size="sm"
                                      variant="outline"
                                      onClick={() =>
                                        void updateItem(item, (latest) => ({
                                          timing: { ...latest.timing, disambiguation: choice },
                                        }))
                                      }
                                    >
                                      The {choice} one
                                    </Button>
                                  ))
                                : null}
                            </div>
                            {item.draftId || item.grid ? null : (
                              <div>
                                <FilePicker
                                  accept={ACCEPT}
                                  label={`Add files to post ${index + 1}`}
                                  multiple
                                  onFiles={(selected) => void addToItem(item, selected)}
                                >
                                  Add files
                                </FilePicker>
                              </div>
                            )}
                            <p className="mt-1 text-label font-medium text-foreground">Accounts</p>
                            {accountIds.length ? (
                              <Table className="text-xs">
                                <TableHeader>
                                  <TableRow>
                                    <TableHead className="w-1/4">Account</TableHead>
                                    <TableHead>Check</TableHead>
                                    <TableHead className="w-1/4">Result</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {accounts
                                    .filter((account) => accountIds.includes(account.id))
                                    .map((account) => {
                                      const on = true
                                      const key = verdictKey(item.id, account.id)
                                      const verdict = verdicts[key]
                                      const post = postOn(item, account.id)
                                      const local = staged.get(account.id)
                                      return (
                                        <TableRow key={account.id} className="align-top">
                                          <TableCell>
                                            <Label className="text-xs font-normal">
                                              <Checkbox
                                                aria-label={`${account.name} for item ${index + 1}`}
                                                disabled={Boolean(item.draftId) || busy !== null}
                                                checked={on}
                                                // Toggles made before the last save lands each apply in turn.
                                                onCheckedChange={(checked) =>
                                                  void updateItem(item, (latest) => ({
                                                    channelConnectionIds: latest.channelConnectionIds
                                                      .filter((id) => id !== account.id)
                                                      .concat(checked === true ? [account.id] : []),
                                                  }))
                                                }
                                              />
                                              {account.name}
                                            </Label>
                                          </TableCell>
                                          <TableCell className="whitespace-normal">
                                            {!on ? (
                                              <span className="text-muted-foreground">Not chosen</span>
                                            ) : verdict ? (
                                              <Label className="items-start text-xs font-normal">
                                                <Checkbox
                                                  aria-label={`Schedule item ${index + 1} on ${account.name}`}
                                                  disabled={!verdict.valid}
                                                  checked={Boolean(selected[key]) && verdict.valid}
                                                  onCheckedChange={(checked) =>
                                                    setSelected((current) => ({
                                                      ...current,
                                                      [key]: checked === true,
                                                    }))
                                                  }
                                                />
                                                <span className="grid justify-items-start gap-1">
                                                  <Pill tone={verdict.valid ? 'green' : 'red'}>
                                                    {verdict.valid ? 'Ready' : 'Needs attention'}
                                                  </Pill>
                                                  <span
                                                    className={
                                                      verdict.valid
                                                        ? 'text-muted-foreground'
                                                        : 'text-destructive'
                                                    }
                                                  >
                                                    {verdict.valid
                                                      ? verdict.scheduledFor
                                                        ? when(verdict.scheduledFor, verdict.timeZone)
                                                        : ''
                                                      : verdict.error}
                                                  </span>
                                                </span>
                                              </Label>
                                            ) : local?.problems.length ? (
                                              <span className="grid justify-items-start gap-1">
                                                <Pill tone="red">Needs attention</Pill>
                                                <span className="text-destructive">
                                                  {local.problems.join(' ')}
                                                </span>
                                              </span>
                                            ) : (
                                              <span className="text-muted-foreground">
                                                {local?.changes.join(' ') || 'Not checked yet'}
                                              </span>
                                            )}
                                          </TableCell>
                                          <TableCell className="whitespace-normal">
                                            {post ? (
                                              <span className="grid justify-items-start gap-1">
                                                <Pill
                                                  tone={
                                                    POST_STATE_TONE[
                                                      postState(post.status, post.scheduledFor)
                                                    ]
                                                  }
                                                >
                                                  {postState(post.status, post.scheduledFor)}
                                                </Pill>
                                                {postFailureReason(post.failureCode) ? (
                                                  <span className="text-destructive">
                                                    {postFailureReason(post.failureCode)}
                                                  </span>
                                                ) : null}
                                                <span className="text-muted-foreground">
                                                  {when(
                                                    post.scheduledFor,
                                                    post.scheduleTimeZone ?? zone
                                                  )}
                                                  {post.url ? (
                                                    <>
                                                      {' · '}
                                                      <a
                                                        className="underline"
                                                        href={post.url}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                      >
                                                        View
                                                      </a>
                                                    </>
                                                  ) : null}
                                                </span>
                                              </span>
                                            ) : on ? (
                                              <span className="text-muted-foreground">
                                                Not scheduled
                                              </span>
                                            ) : null}
                                          </TableCell>
                                        </TableRow>
                                      )
                                    })}
                                </TableBody>
                              </Table>
                            ) : accounts.length ? (
                              <p className="text-xs text-muted-foreground">
                                No account chosen. Choose one below.
                              </p>
                            ) : (
                              <p className="text-xs text-muted-foreground">
                                This profile has no connected accounts.{' '}
                                <Link className="underline" href="/settings/publishing-brands">
                                  Connect one
                                </Link>{' '}
                                to check and schedule posts.
                              </p>
                            )}
                            {otherAccounts.length ? (
                              <div className="grid gap-1 text-xs">
                                <p className="text-muted-foreground">
                                  {item.draftId
                                    ? 'Other accounts in this profile. Change a saved post’s accounts in its draft.'
                                    : 'Other accounts in this profile'}
                                </p>
                                <div className="flex flex-wrap gap-x-4 gap-y-1">
                                  {otherAccounts.map((account) => (
                                    <Label className="text-xs font-normal" key={account.id}>
                                      <Checkbox
                                        aria-label={`${account.name} for item ${index + 1}`}
                                        checked={false}
                                        disabled={Boolean(item.draftId) || busy !== null}
                                        onCheckedChange={(checked) =>
                                          checked === true &&
                                          void updateItem(item, (latest) => ({
                                            channelConnectionIds: [
                                              ...latest.channelConnectionIds.filter(
                                                (id) => id !== account.id
                                              ),
                                              account.id,
                                            ],
                                          }))
                                        }
                                      />
                                      {account.name}
                                    </Label>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        {outcomes[item.id] ? (
                          <p
                            role={settledWell(outcomes[item.id]) ? 'status' : 'alert'}
                            className={
                              outcomes[item.id] === 'Scheduled'
                                ? 'text-emerald-700 dark:text-emerald-300'
                                : settledWell(outcomes[item.id])
                                  ? 'text-muted-foreground'
                                  : 'text-destructive'
                            }
                          >
                            {outcomes[item.id]}
                          </p>
                        ) : null}
                      </li>
                    )
                  })}
                </ol>
              ) : null}
              <div className={cn(items.length > 0 && 'border-t border-border')}>
                <PasteBox
                  author={destinationsOf(sharedAccounts)[0]}
                  busy={busy !== null}
                  channel={countingChannel}
                  focus={start === 'text' && items.length === 0}
                  hasPosts={items.length > 0}
                  onAdd={addPasted}
                  restore={restore}
                  room={room}
                />
                {lastImport && canUndoImport ? (
                  <p
                    className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2 text-label text-muted-foreground sm:ps-16"
                    role="status"
                  >
                    Added {lastImport.ids.length} post{lastImport.ids.length === 1 ? '' : 's'}.
                    <Button
                      className="h-7 px-2"
                      disabled={busy !== null}
                      size="sm"
                      variant="ghost"
                      onClick={() => void undoImport()}
                    >
                      Undo import
                    </Button>
                  </p>
                ) : null}
              </div>
            </div>
          </Section>
        </div>

        {/* Full width on wide screens: its actions sit clear of the bottom-centre toasts. */}
        {items.length ? (
          <section
            className="sticky bottom-2 z-10 grid gap-3 rounded-xl border border-border bg-card/95 p-3 shadow-popover backdrop-blur sm:bottom-4 sm:p-4 xl:col-span-2"
            aria-label="Save and schedule"
          >
            <div className="grid gap-0.5">
              <p className="text-ui font-medium text-foreground" data-testid="batch-readiness">
                {[
                  `${drafted.length} draft${drafted.length === 1 ? '' : 's'} saved`,
                  checked ? `${chosenPosts} ready` : null,
                  audience,
                  range ?? 'no times yet',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              <p role="status" className="text-label text-muted-foreground">
                {checked
                  ? `${chosenCount} selection${chosenCount === 1 ? '' : 's'} will be scheduled${
                      attention
                        ? `; ${attention} need${attention === 1 ? 's' : ''} attention and will not be`
                        : ''
                    }. `
                  : `${drafted.length} of ${items.length} saved as drafts${
                      notRendered
                        ? `; ${notRendered} video${notRendered === 1 ? '' : 's'} not rendered yet`
                        : ''
                    }${
                      unsaved.length - ready.length - notRendered > 0
                        ? `; ${unsaved.length - ready.length - notRendered} still uploading or waiting for files`
                        : ''
                    }. `}
                Nothing goes out until you choose Schedule.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Select
                value={timesMode}
                onValueChange={(value) => setTimesMode(value as 'queue' | 'hourly' | 'spread')}
              >
                <SelectTrigger aria-label="Batch time mode">
                  <CalendarIcon aria-hidden className="size-4 text-muted-foreground" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="queue">Next queue slots</SelectItem>
                  <SelectItem value="hourly">Every hour</SelectItem>
                  <SelectItem value="spread">Spread over days</SelectItem>
                </SelectContent>
              </Select>
              {timesMode === 'hourly' ? (
                <>
                  <div className="grid gap-1 text-label text-muted-foreground">
                    First post
                    <LocalTimeFields
                      onValidityChange={setHourlyValid}
                      label="Hourly start"
                      value={hourly.start}
                      onChange={(edit) =>
                        setHourly((current) => ({ ...current, start: edit(current.start) }))
                      }
                    />
                  </div>
                  <Label className="grid gap-1 text-label font-normal text-muted-foreground">
                    Last post of the day by
                    <TimePicker
                      aria-label="Hourly end of day"
                      value={hourly.until}
                      onChange={(until) => setHourly((current) => ({ ...current, until }))}
                    />
                  </Label>
                </>
              ) : null}
              {timesMode === 'spread' ? (
                <>
                  <div className="grid gap-1 text-sm">
                    Start ({zone})
                    <LocalTimeFields
                      onValidityChange={setSpreadValid}
                      label="Spread start"
                      value={spread.start}
                      onChange={(edit) =>
                        setSpread((current) => ({ ...current, start: edit(current.start) }))
                      }
                    />
                  </div>
                  <Label className="grid gap-1 font-normal">
                    Posts per day
                    <Input
                      className="w-24"
                      type="number"
                      min={1}
                      max={24}
                      value={spread.perDay}
                      onChange={(event) => {
                        const perDay = Math.min(24, Math.max(1, Number(event.target.value) || 1))
                        // A day's posts must still fit, so the spacing follows the count.
                        const fits = Math.max(...spreadHourOptions(perDay)) * 60
                        setSpread({ ...spread, perDay, spacing: Math.min(spread.spacing, fits) })
                      }}
                    />
                  </Label>
                  {spread.perDay > 1 ? (
                    <Label className="grid gap-1 font-normal">
                      Time between posts
                      <Select
                        value={String(spread.spacing)}
                        onValueChange={(value) =>
                          setSpread({ ...spread, spacing: Number(value) })
                        }
                      >
                        <SelectTrigger aria-label="Time between posts">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {spreadHourOptions(spread.perDay).map((hours) => (
                            <SelectItem key={hours} value={String(hours * 60)}>
                              {hours} hour{hours === 1 ? '' : 's'}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Label>
                  ) : null}
                  <Label className="font-normal">
                    <Checkbox
                      checked={spread.shift > 0}
                      onCheckedChange={(checked) =>
                        setSpread({ ...spread, shift: checked === true ? 55 : 0 })
                      }
                    />
                    Randomize times by 0–55 minutes
                  </Label>
                </>
              ) : null}
              <Button
                disabled={busy !== null || !planReady || !items.length}
                onClick={() => void planAll()}
                title="Saves posts not yet saved as drafts, proposes their times and checks every post on its accounts"
                // The next step is the primary action: planning, then scheduling once checked.
                variant={checked ? 'outline' : 'default'}
              >
                {busy === 'times'
                  ? 'Planning…'
                  : busy === 'drafts'
                    ? 'Saving drafts…'
                    : busy === 'check'
                      ? 'Checking…'
                      : 'Plan times'}
              </Button>
              <div className="ms-auto flex flex-wrap items-center gap-2">
                {ready.length ? (
                  <Button
                    size={compact}
                    variant="outline"
                    disabled={busy !== null || hasInvalidTimes}
                    onClick={() => void saveDrafts()}
                  >
                    {busy === 'drafts' ? 'Saving drafts…' : 'Save ready items as drafts'}
                  </Button>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button aria-label="More batch actions" size="icon" variant="ghost">
                      <MoreIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {canPublish ? (
                      <DropdownMenuItem
                        disabled={busy !== null || hasInvalidTimes || !drafted.length}
                        onSelect={() => void check()}
                      >
                        Check every item and account
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem
                      disabled={busy !== null || hasInvalidTimes || !drafted.length}
                      onSelect={() => void requestReviews()}
                    >
                      Request review for drafts
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                {canPublish ? (
                  <Button
                    size={compact}
                    variant={checked ? 'default' : 'outline'}
                    disabled={busy !== null || submitting || (chosenCount === 0 && !unanswered.current)}
                    onClick={() => void schedule()}
                  >
                    {busy === 'schedule'
                      ? 'Scheduling…'
                      : unanswered.current
                        ? 'Try scheduling again'
                        : `Schedule ${chosenPosts} post${chosenPosts === 1 ? '' : 's'}${
                            chosenCount > chosenPosts ? ` (${chosenCount} in all)` : ''
                          }`}
                  </Button>
                ) : (
                  <p className="self-center text-label text-muted-foreground">
                    A publisher schedules these drafts after review.
                  </p>
                )}
              </div>
            </div>
            {timesMode === 'hourly' ? (
              <p className="text-label text-muted-foreground" data-testid="hourly-explainer">
                {hourlyDay
                  ? `One post an hour from ${hourly.start.slice(11, 16) || '…'} to ${hourly.until}: up to ${hourlyDay} a day. Posts past that continue the next day at ${hourly.start.slice(11, 16) || 'the start'}.`
                  : 'The last post of the day must come after the first.'}
              </p>
            ) : null}
            {summary.first && summary.last ? (
              <p className="hidden text-label text-muted-foreground sm:block" data-testid="batch-summary">
                {batchAudience(items, accounts)}, first {shortWhen(summary.first, zone)}, last{' '}
                {shortWhen(summary.last, zone)}, on {summary.calendarDays} calendar day
                {summary.calendarDays === 1 ? '' : 's'}.
                {summary.withoutTime ? ` ${summary.withoutTime} still need a time.` : ''}
              </p>
            ) : null}
            {submitting ? (
              <p
                role="status"
                className="text-sm text-muted-foreground"
                data-testid="submit-running"
              >
                Scheduling in the background. You can close this page: it carries on, and each
                post&rsquo;s result is here when you come back.
              </p>
            ) : null}
            {postsLeft !== null && chosenCount > postsLeft ? (
              <p role="status" className="text-sm text-destructive" data-testid="quota-warning">
                This schedules {chosenCount} posts and your plan has {postsLeft} left this month.
                Posts past the limit are refused with a reason, and the rest stay scheduled.
              </p>
            ) : null}
          </section>
        ) : null}
      </div>
      <BatchPreviewSheet
        accounts={accounts}
        itemId={previewing}
        items={items}
        onItemChange={setPreviewing}
        options={videoOptions}
        zone={zone}
      />
    </Page>
  )
}
