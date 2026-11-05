'use client'

import Link from 'next/link'
import * as React from 'react'
import { useDropzone } from 'react-dropzone'
import { toast } from 'sonner'
import {
  CalendarIcon,
  DeleteIcon,
  ImageIcon,
  OutwardIcon,
  PdfIcon,
  UploadIcon,
  VideoIcon,
} from '@/components/platform-shell/icons'
import {
  EmptyState,
  Group,
  Page,
  Pill,
  type PillTone,
  Row,
  Section,
} from '@/components/platform-ui'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DatePicker } from '@/components/ui/date-picker'
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
  batchSummary,
  itemAccounts,
  pendingAccounts,
  postOn,
  queueTimings,
  readTiming,
  runOutcomes,
  spreadHourOptions,
  spreadTimings,
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
import type { VersionOptions } from '@/lib/write/document'
import { importedBody, importedPosts } from '@/lib/write/import-text'
import { uploadByteLimit } from '@/lib/write/media-limits'
import { cn } from '@/lib/utils'
import { safeAssetFileName, saveExportToWorkspace } from '@/lib/workspace/save-export'
import { expandSpintax } from '@/lib/write/spintax'
import { VideoOptions } from '../composer/video-options'
import { BulkCaptionPanel } from './BulkCaptionPanel'
import { FilePicker } from './FilePicker'
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

/** A row of the import preview; `files` holds each attachment's file, in order. */
type Staged = {
  files: (File | undefined)[]
  input: BatchItemInput
  line: number
  problems: string[]
}

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
export type BatchStart = 'videos' | 'images' | 'grid'
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

/** A length as minutes and seconds, such as 1:05. */
const clock = (ms: number) =>
  `${Math.floor(ms / 60_000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`

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
  const [local, setLocal] = React.useState<string>()
  React.useEffect(() => {
    if (stored || !file || !type.startsWith('image/')) return
    const url = URL.createObjectURL(file)
    setLocal(url)
    return () => URL.revokeObjectURL(url)
  }, [file, stored, type])
  const picture = type.startsWith('image/') ? (stored ? assetContentUrl(stored) : local) : undefined
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
  start,
}: {
  initial: ContentBatch
  accounts: BatchAccount[]
  canPublish: boolean
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

  // Adding items: selected files, a CSV and shared settings, previewed first.
  const [csv, setCSV] = React.useState('')
  const [chosen, setChosen] = React.useState<File[]>([])
  const [perImage, setPerImage] = React.useState(false)
  const [accountFilter, setAccountFilter] = React.useState('')
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
  const dropzone = useDropzone({ noClick: true, noKeyboard: true, onDrop: setChosen })
  const folderChosen = chosen.some(isInFolder)
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
          staged: posts.map((post, index) => ({
            files: post.files,
            line: index + 1,
            problems: post.problems,
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
          })),
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
        return {
          files: rowFiles,
          line: row.line,
          problems: [
            ...row.problems,
            ...matched.problems,
            ...tooLarge,
            ...(channelIssue ? [channelIssue] : []),
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
    return saveItem(item.id, typeof body === 'function' ? body : () => body).catch(
      (error: unknown) => {
        toast.error(error instanceof Error ? error.message : 'The item could not be saved.')
      }
    )
  }

  // Bulk actions on staged items, with each item's own values kept unless asked.
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

  const [timesMode, setTimesMode] = React.useState<'queue' | 'spread'>('queue')
  const [spread, setSpread] = React.useState({ start: '', perDay: 2, spacing: 240, shift: 0 })
  const [seed] = React.useState(() => crypto.randomUUID())
  const planTimes = async () => {
    // Items with nothing scheduled yet on some account, or no accounts chosen yet.
    const targets = items.filter((item) => {
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
      for (const [index, item] of targets.entries())
        await updateItem(item, { timing: timings[index] })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The times could not be planned.')
    } finally {
      setBusy(null)
    }
  }

  // Drafts: each finished item becomes its own draft; a retry returns the same one.
  const saveDrafts = async () => {
    setBusy('drafts')
    // An edit still being saved, such as a caption left by clicking here, goes first.
    await settled()
    let failed = 0
    for (const item of itemsRef.current) {
      if (item.draftId || item.media.some((entry) => !entry.assetId) || waitingToRender(item))
        continue
      try {
        const posts = importedPosts(item.caption)
        const body = importedBody(posts.length ? posts : [''])
        const pdf = item.media.find((entry) => entry.mediaType === 'application/pdf')
        const channels = accounts
          .filter((account) => item.channelConnectionIds.includes(account.id))
          .map((account) => account.channel)
        const platformVersions = stagedVersions(item, channels, videoOptions)
        for (const entry of item.media)
          body.push({
            type: entry === pdf ? 'file' : entry.mediaType?.startsWith('video/') ? 'video' : 'img',
            assetId: entry.assetId!,
            url: assetContentUrl(entry.assetId!),
            ...(entry.mediaType ? { mimeType: entry.mediaType } : {}),
            name: entry.fileName ?? '',
            children: [{ text: '' }],
          })
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
      await draftsApi.review(item.draftId, { action: 'request' }).catch((error: unknown) => {
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
  const check = async () => {
    setBusy('check')
    try {
      // The server checks each item's stored time, so edits on their way land first.
      await settled()
      const requests = itemsRef.current.flatMap((item) => {
        const { remaining } = pendingAccounts(item, itemAccounts(item))
        return remaining.length ? [{ itemId: item.id, channelConnectionIds: remaining }] : []
      })
      if (!requests.length) {
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
      setVerdicts(next)
      setPostsLeft(
        await trpc.billing.summary.query().then(
          ({ posts }) => posts.left,
          () => null
        )
      )
      setSelected(
        Object.fromEntries(
          results.map((result) => [
            verdictKey(result.itemId, result.channelConnectionId),
            result.valid,
          ])
        )
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The batch could not be checked.')
    } finally {
      setBusy(null)
    }
  }
  const chosenCount = Object.entries(selected).filter(
    ([key, on]) => on && verdicts[key]?.valid
  ).length
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
  // The next step is the primary action; the others stay available as outline.
  const next = ready.length ? 'save' : !drafted.length ? null : checked ? 'schedule' : 'check'
  // Smaller action buttons on phones, where the bar stays over the posts.
  const compact = useIsMobile() ? 'sm' : 'default'
  // A batch started for grid videos, or already holding them, opens on them.
  const gridFirst = start === 'grid' || items.some((item) => item.grid)
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
          Each post here is <strong>its own draft</strong>, up to {BATCH_ITEM_LIMIT}. To put several
          files in one post, add them to the same CSV row. Times are in {zone}. The batch saves as
          you go, so you can reopen it from Write on any device.
        </>
      }
      actions={
        <>
          <Pill>
            {items.length} of {BATCH_ITEM_LIMIT} posts
          </Pill>
          <Button
            variant="outline"
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
      <div className="grid grid-cols-[minmax(0,1fr)] gap-8" data-testid="bulk-batch">
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

        {gridFirst ? gridCreator : null}

        {items.length < BATCH_ITEM_LIMIT ? (
          <Section
            title="Add posts"
            description="Choose files, paste or load a CSV, or both. Nothing is added until you review the preview."
          >
            <Group>
              <Row
                label={
                  start === 'videos'
                    ? 'Videos'
                    : start === 'images'
                      ? 'Image folders'
                      : 'Photos, videos and folders'
                }
                description={
                  start === 'videos'
                    ? 'Each video becomes its own post, or matches a CSV row by its exact name. MP4, MOV and WebM; each destination’s own length and size limits are checked before scheduling.'
                    : start === 'images'
                      ? 'A folder of images becomes one post, and a parent folder makes one post per subfolder, in name order. JPEG, PNG, WebP and GIF.'
                      : 'Each file becomes its own post, or matches a CSV row by its exact name. A folder of images becomes one post, and a parent folder makes one post per subfolder, in name order. JPEG, PNG, WebP, GIF, MP4, MOV and WebM; PDFs go to LinkedIn as documents.'
                }
              >
                <div
                  {...dropzone.getRootProps({
                    className: cn(
                      'flex w-full flex-col items-start gap-2 rounded-xl border border-dashed border-border p-4',
                      dropzone.isDragActive && 'border-primary bg-muted'
                    ),
                  })}
                >
                  <div className="flex flex-wrap gap-2">
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
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void addEmptyPost()}
                    >
                      Add an empty post
                    </Button>
                    {!showGrid ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setGridOpen(true)}
                      >
                        Create grid videos
                      </Button>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {chosen.length
                      ? `${chosen.length} file${chosen.length === 1 ? '' : 's'} · ${megabytes(chosen.reduce((sum, file) => sum + file.size, 0))}`
                      : 'Or drop files or folders here.'}
                  </p>
                  {start !== 'videos' && (folderChosen || start === 'images') ? (
                    <Label className="font-normal">
                      <Checkbox
                        checked={perImage}
                        onCheckedChange={(checked) => setPerImage(checked === true)}
                      />
                      One post per image
                    </Label>
                  ) : null}
                </div>
              </Row>
              <Row
                label="CSV"
                layout="stacked"
                description={
                  <>
                    Optional. Columns: <code>caption</code>, <code>asset</code> (file names or
                    workspace asset IDs, separated by <code>;</code>), <code>channels</code>,{' '}
                    <code>time</code> (<code>2026-11-03 09:30</code>) and <code>timezone</code>.
                    Other columns are ignored.
                  </>
                }
              >
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
              </Row>
              <Row
                label="Shared caption"
                layout="stacked"
                description="Used for posts whose row or file has no caption. {Hello|Hi} gives each post its own variation."
              >
                <Textarea
                  aria-label="Shared caption"
                  rows={2}
                  value={sharedCaption}
                  onChange={(event) => setSharedCaption(event.target.value)}
                />
              </Row>
              <Row
                label="Shared accounts"
                description="Used for posts whose row names no channels."
              >
                {accounts.length > 8 ? (
                  <Input
                    aria-label="Search accounts"
                    className="w-full"
                    placeholder="Search accounts"
                    value={accountFilter}
                    onChange={(event) => setAccountFilter(event.target.value)}
                  />
                ) : null}
                {accounts.length ? (
                  accounts
                    .filter((account) =>
                      account.name.toLowerCase().includes(accountFilter.trim().toLowerCase())
                    )
                    .map((account) => (
                      <Label key={account.id} className="font-normal">
                        <Checkbox
                          checked={sharedAccounts.includes(account.id)}
                          onCheckedChange={(checked) =>
                            setSharedAccounts((current) =>
                              checked === true
                                ? [...current, account.id]
                                : current.filter((id) => id !== account.id)
                            )
                          }
                        />
                        {account.name}
                      </Label>
                    ))
                ) : (
                  <Button asChild variant="outline" size="sm">
                    <Link href="/settings/publishing-brands">Connect an account</Link>
                  </Button>
                )}
              </Row>
              <Row>
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => void previewImport()}
                    disabled={!chosen.length && !csv.trim()}
                  >
                    Preview import
                  </Button>
                  {unsaved.length ? (
                    <Button
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void applySharedAccounts()}
                    >
                      Apply shared accounts to unsaved posts
                    </Button>
                  ) : null}
                </div>
              </Row>
            </Group>
            {preview ? (
              <div className="grid gap-3" data-testid="import-preview">
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
                <Group>
                  <Table className="text-xs">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Row</TableHead>
                        <TableHead>Caption</TableHead>
                        <TableHead>Media</TableHead>
                        <TableHead>Accounts</TableHead>
                        <TableHead>Time</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.staged.map((row) => (
                        <TableRow key={row.input.importKey} className="align-top">
                          <TableCell>{row.line}</TableCell>
                          <TableCell className="max-w-64 truncate">
                            {row.input.caption || (
                              <span className="text-muted-foreground">No caption</span>
                            )}
                          </TableCell>
                          <TableCell className="max-w-48 truncate">
                            {row.input.media
                              .map(
                                (media) => ('assetId' in media && media.assetId) || media.fileName
                              )
                              .join(', ') || <span className="text-muted-foreground">None</span>}
                          </TableCell>
                          <TableCell>
                            {row.input.channelConnectionIds.map(accountName).join(', ') || (
                              <span className="text-muted-foreground">None</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {row.input.timing.localTime
                              ? `${row.input.timing.localTime.replace('T', ' ')} (${row.input.timing.timeZone})`
                              : 'Set later'}
                          </TableCell>
                          <TableCell className="whitespace-normal">
                            {row.problems.length ? (
                              <div className="grid justify-items-start gap-1">
                                <Pill tone="red">Needs fixing</Pill>
                                {row.problems.map((problem) => (
                                  <p key={problem} role="alert" className="text-destructive">
                                    {problem}
                                  </p>
                                ))}
                              </div>
                            ) : (
                              <Pill tone="green">Ready</Pill>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Group>
                <div>
                  <Button
                    disabled={busy !== null || !preview.staged.some((row) => !row.problems.length)}
                    onClick={() => void addValid()}
                  >
                    Add {preview.staged.filter((row) => !row.problems.length).length} ready rows
                    {preview.staged.some((row) => row.problems.length)
                      ? ` (${preview.staged.filter((row) => row.problems.length).length} need fixing first)`
                      : ''}
                  </Button>
                </div>
              </div>
            ) : null}
          </Section>
        ) : null}

        {gridFirst ? null : gridCreator}

        {videoChannels.length ? (
          <Section
            title="Video options"
            description={`YouTube and TikTok need these before scheduling. They apply to the ${unsaved.length} post${unsaved.length === 1 ? '' : 's'} not yet saved as drafts; change one post's in Write afterwards. An empty YouTube title uses each post's first caption line, or its file name.`}
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

        <BulkCaptionPanel
          accounts={accounts}
          disabled={busy !== null}
          items={items}
          onApply={applyCaptions}
        />

        <Section
          title="Times"
          description="Set each post's time below, or fill the times of posts not yet scheduled. Queue slots are a preview: a slot taken before you schedule is refused, not moved."
        >
          <Group>
            <Row>
              <div className="flex flex-wrap items-end gap-3">
                <Label className="grid gap-1 font-normal">
                  Plan
                  <Select
                    value={timesMode}
                    onValueChange={(value) => setTimesMode(value as 'queue' | 'spread')}
                  >
                    <SelectTrigger aria-label="Batch time mode">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="queue">Fill the queue</SelectItem>
                      <SelectItem value="spread">Spread over days</SelectItem>
                    </SelectContent>
                  </Select>
                </Label>
                {timesMode === 'spread' ? (
                  <>
                    <div className="grid gap-1 text-sm">
                      Start ({zone})
                      <LocalTimeFields
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
                  variant="outline"
                  disabled={busy !== null || !items.length}
                  onClick={() => void planTimes()}
                >
                  <CalendarIcon />
                  {busy === 'times' ? 'Filling…' : 'Fill times'}
                </Button>
              </div>
            </Row>
          </Group>
          {summary.first && summary.last ? (
            <p className="text-sm text-muted-foreground" data-testid="batch-summary">
              {summary.posts} post{summary.posts === 1 ? '' : 's'} to {summary.destinations}{' '}
              destination{summary.destinations === 1 ? '' : 's'}. First {when(summary.first, zone)},
              last {when(summary.last, zone)}, on {summary.calendarDays} calendar day
              {summary.calendarDays === 1 ? '' : 's'}.
              {summary.withoutTime ? ` ${summary.withoutTime} still need a time.` : ''}
            </p>
          ) : null}
        </Section>

        <Section
          title="Posts"
          description="Each post is checked on each of its accounts before it can be scheduled."
        >
          {items.length ? (
            <ol className="grid gap-4" aria-label="Batch items">
              {items.map((item, index) => {
                const timing = readTiming(item.timing)
                const accountIds = itemAccounts(item)
                const staged = stagedChecks(item, accounts)
                const status = itemStatus(item)
                return (
                  <li
                    key={item.id}
                    className="grid grid-cols-[minmax(0,1fr)] gap-4 rounded-2xl border border-border bg-[var(--platform-group,var(--card))] p-4 text-sm sm:p-5"
                    data-testid="batch-item"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex size-6 items-center justify-center rounded-full bg-muted text-xs text-muted-foreground tabular-nums">
                        {index + 1}
                      </span>
                      <strong className="min-w-0 flex-1 truncate font-medium">
                        {item.draft?.title ?? (item.caption.split('\n')[0] || 'Untitled post')}
                      </strong>
                      <Pill tone={status.tone}>{status.text}</Pill>
                      {item.draftId ? (
                        <Button asChild size="sm" variant="ghost">
                          <a href={`/publish/${item.draftId}`} target="_blank" rel="noreferrer">
                            Open draft
                            <OutwardIcon />
                          </a>
                        </Button>
                      ) : (
                        <Button
                          aria-label={`Remove post ${index + 1}`}
                          title="Remove"
                          size="icon-sm"
                          variant="ghost"
                          onClick={() =>
                            void call(`${base}/items/${encodeURIComponent(item.id)}`, {
                              method: 'DELETE',
                            }).then(reload)
                          }
                        >
                          <DeleteIcon />
                        </Button>
                      )}
                    </div>
                    <div className="grid gap-4 md:grid-cols-[auto_minmax(0,1fr)]">
                      {item.media.length ? (
                        <ul className="flex flex-wrap content-start gap-3 md:max-w-[19rem]">
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
                      <div className="grid content-start gap-3">
                        {item.draftId ? (
                          <p className="whitespace-pre-wrap text-muted-foreground">
                            {item.draft?.plainText || 'No caption'}
                          </p>
                        ) : item.grid ? null : (
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
                        {item.draftId ? null : (
                          <Textarea
                            // A bulk caption replaces what this box first showed.
                            key={item.caption}
                            aria-label={`Caption for item ${index + 1}`}
                            defaultValue={item.caption}
                            placeholder="Caption"
                            rows={3}
                            onBlur={(event) => {
                              if (event.target.value !== item.caption)
                                void updateItem(item, { caption: event.target.value })
                            }}
                          />
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-muted-foreground">
                            {item.timing.timeZone || zone}
                          </span>
                          <LocalTimeFields
                            disabled={busy !== null}
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
                          <span
                            className={cn(
                              'text-xs',
                              timing.kind === 'problem'
                                ? 'text-destructive'
                                : 'text-muted-foreground'
                            )}
                          >
                            {timing.kind === 'at'
                              ? `Goes out ${when(timing.at, timing.zone || zone)}`
                              : timing.text}
                          </span>
                        </div>
                      </div>
                    </div>
                    {accounts.length ? (
                      <Table className="text-xs">
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-1/4">Account</TableHead>
                            <TableHead>Check</TableHead>
                            <TableHead className="w-1/4">Result</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {accounts.map((account) => {
                            const on = accountIds.includes(account.id)
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
                                          POST_STATE_TONE[postState(post.status, post.scheduledFor)]
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
                                        {when(post.scheduledFor, post.scheduleTimeZone ?? zone)}
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
                                    <span className="text-muted-foreground">Not scheduled</span>
                                  ) : null}
                                </TableCell>
                              </TableRow>
                            )
                          })}
                        </TableBody>
                      </Table>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        This profile has no connected accounts.{' '}
                        <Link className="underline" href="/settings/publishing-brands">
                          Connect one
                        </Link>{' '}
                        to check and schedule posts.
                      </p>
                    )}
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
          ) : (
            <EmptyState
              icon={ImageIcon}
              title="No posts yet"
              description="Add photos, videos or a CSV above. Each becomes a post you can check and schedule here."
            />
          )}
        </Section>

        {items.length ? (
          <section
            className="sticky bottom-2 z-10 grid gap-2 rounded-2xl border border-border bg-background/95 p-3 shadow-lg backdrop-blur sm:bottom-4 sm:gap-3 sm:p-4"
            aria-label="Save and schedule"
          >
            <p role="status" className="text-xs text-muted-foreground sm:text-sm">
              {checked
                ? `${chosenCount} selection${chosenCount === 1 ? '' : 's'} will be scheduled${
                    attention
                      ? `; ${attention} need${attention === 1 ? 's' : ''} attention and will not be`
                      : ''
                  }. Nothing goes out until you choose Schedule.`
                : `${drafted.length} of ${items.length} saved as drafts${
                    notRendered
                      ? `; ${notRendered} video${notRendered === 1 ? '' : 's'} not rendered yet`
                      : ''
                  }${
                    unsaved.length - ready.length - notRendered > 0
                      ? `; ${unsaved.length - ready.length - notRendered} still uploading or waiting for files`
                      : ''
                  }.`}
            </p>
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
            <div className="flex flex-wrap gap-2">
              <Button
                size={compact}
                variant={next === 'save' ? 'default' : 'outline'}
                disabled={busy !== null || !ready.length}
                onClick={() => void saveDrafts()}
              >
                {busy === 'drafts' ? 'Saving drafts…' : 'Save ready items as drafts'}
              </Button>
              <Button
                size={compact}
                variant="outline"
                disabled={busy !== null || !drafted.length}
                onClick={() => void requestReviews()}
              >
                Request review for drafts
              </Button>
              {canPublish ? (
                <>
                  <Button
                    size={compact}
                    variant={next === 'check' ? 'default' : 'outline'}
                    disabled={busy !== null || !drafted.length}
                    onClick={() => void check()}
                  >
                    {busy === 'check' ? 'Checking…' : 'Check every item and account'}
                  </Button>
                  <Button
                    size={compact}
                    variant={next === 'schedule' ? 'default' : 'outline'}
                    disabled={
                      busy !== null || submitting || (chosenCount === 0 && !unanswered.current)
                    }
                    onClick={() => void schedule()}
                  >
                    {busy === 'schedule'
                      ? 'Scheduling…'
                      : unanswered.current
                        ? 'Try scheduling again'
                        : `Schedule ${chosenCount} selected`}
                  </Button>
                </>
              ) : (
                <p className="self-center text-sm text-muted-foreground">
                  A publisher schedules these drafts after review.
                </p>
              )}
            </div>
          </section>
        ) : null}
      </div>
    </Page>
  )
}
