'use client'

import Link from 'next/link'
import * as React from 'react'
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
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
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
import type {
  BatchItem,
  BatchItemInput,
  BatchMedia,
  BatchValidation,
  ContentBatch,
} from '@/lib/api/contracts/content-batches'
import { call, DraftRequestError, draftsApi } from '@/lib/content-drafts/client'
import { POST_STATE_TONE, postFailureReason, postState } from '@/lib/content-drafts/post-status'
import { assetContentUrl } from '@/lib/editor/services'
import { useTRPCClient } from '@/lib/trpc/react'
import {
  type BatchAccount,
  itemAccounts,
  pendingAccounts,
  postOn,
  queueTimings,
  readTiming,
  spreadTimings,
  stagedChecks,
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
import { importedBody, importedPosts } from '@/lib/write/import-text'
import { readVersions, withOptions } from '@/lib/write/versions'
import { cn } from '@/lib/utils'
import { safeAssetFileName, saveExportToWorkspace } from '@/lib/workspace/save-export'

/** Files a batch takes: the formats some destination publishes; a PDF goes to LinkedIn as a document. */
const ACCEPT =
  'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,application/pdf'
/** Uploads at once: enough to keep a link busy, few enough to bound memory and sockets. */
const UPLOAD_CONCURRENCY = 3
const ITEM_LIMIT = 50

type Staged = { input: BatchItemInput; line: number; problems: string[] }
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
      <Input
        aria-label={`${label} time`}
        className="w-36"
        disabled={disabled}
        type="time"
        value={time}
        onChange={(event) => {
          const next = event.target.value
          if (day && next) onChange((current) => `${current.split('T')[0] || day}T${next}`)
        }}
      />
    </span>
  )
}

/** A button that opens the file chooser; the input stays labelled for assistive tech and tests. */
function FilePicker({
  accept,
  children,
  label,
  multiple,
  onFiles,
}: {
  accept: string
  children?: React.ReactNode
  label: string
  multiple?: boolean
  onFiles: (files: File[]) => void
}) {
  const input = React.useRef<HTMLInputElement>(null)
  return (
    <>
      <Input
        ref={input}
        aria-label={label}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []))
          event.target.value = ''
        }}
      />
      <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}>
        <UploadIcon />
        {children ?? label}
      </Button>
    </>
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
}: {
  initial: ContentBatch
  accounts: BatchAccount[]
  canPublish: boolean
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
        media: item.media.map(({ assetId, fileName, bytes, uploadAssetId }, at): BatchMedia =>
          at === index
            ? entry
            : assetId
              ? { assetId, ...(fileName ? { fileName } : {}) }
              : { fileName: fileName!, bytes: bytes!, ...(uploadAssetId ? { uploadAssetId } : {}) }
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
  const [sharedCaption, setSharedCaption] = React.useState('')
  const [sharedAccounts, setSharedAccounts] = React.useState<string[]>(
    accounts.map((account) => account.id)
  )
  const [preview, setPreview] = React.useState<{
    /** The files this preview matched; Add uploads these, not a later selection. */
    files: File[]
    mapping: ImportMapping | null
    staged: Staged[]
    unused: string[]
  } | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)

  const previewImport = async () => {
    try {
      if (chosen.length + items.length > ITEM_LIMIT && !csv.trim())
        throw new Error(
          `A batch holds up to ${ITEM_LIMIT} posts. Choose fewer files or start another batch.`
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
        const chosenAccounts = row.channels.length
          ? accounts
              .filter((account) => row.channels.includes(account.channel))
              .map((account) => account.id)
          : sharedAccounts
        return {
          line: row.line,
          problems: [...row.problems, ...matched.problems, ...(channelIssue ? [channelIssue] : [])],
          input: {
            importKey: importKey(),
            caption: row.caption || sharedCaption,
            media: matched.media,
            channelConnectionIds: chosenAccounts,
            timing: row.time
              ? { mode: 'time', localTime: row.time, timeZone: row.timeZone ?? zone }
              : {},
          },
        }
      })
      if (items.length + staged.length > ITEM_LIMIT)
        throw new Error(
          `A batch holds up to ${ITEM_LIMIT} posts; this would make ${items.length + staged.length}.`
        )
      setPreview({
        files: chosen,
        mapping,
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
      // Hold each chosen file for the attachments it was matched to.
      const byName = new Map(preview.files.map((file) => [safeAssetFileName(file.name), file]))
      const added = new Set(valid.map((row) => row.input.importKey))
      for (const item of next.items ?? []) {
        if (!added.has(item.importKey)) continue
        item.media.forEach((entry, index) => {
          const file = !entry.assetId && entry.fileName ? byName.get(entry.fileName) : undefined
          if (file) files.current.set(`${item.id}/${index}`, file)
        })
      }
      setBatch(next)
      itemsRef.current = next.items ?? []
      // Rows that were not added stay listed with their problems, so none is lost unseen.
      const left = preview.staged.filter((row) => row.problems.length > 0)
      setPreview(
        left.length
          ? { files: preview.files, mapping: preview.mapping, staged: left, unused: [] }
          : null
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
      const name = safeAssetFileName(file.name)
      for (const { entry, key } of missingFiles)
        if (entry.fileName === name && entry.bytes === file.size) files.current.set(key, file)
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
  const applyShared = async (what: 'caption' | 'accounts') => {
    setBusy(what)
    for (const item of items) {
      if (item.draftId) continue
      if (what === 'caption' && item.caption.trim()) continue
      await updateItem(
        item,
        what === 'caption' ? { caption: sharedCaption } : { channelConnectionIds: sharedAccounts }
      )
    }
    setBusy(null)
  }

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
      if (item.draftId || item.media.some((entry) => !entry.assetId)) continue
      try {
        const posts = importedPosts(item.caption)
        const body = importedBody(posts.length ? posts : [''])
        const pdf = item.media.find((entry) => entry.mediaType === 'application/pdf')
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
              ...(pdf
                ? {
                    platformVersions: withOptions(readVersions(undefined), 'linkedin', {
                      document: {
                        assetId: pdf.assetId!,
                        title: pdf.fileName?.replace(/\.pdf$/i, '').slice(0, 200) || 'Document',
                      },
                    }),
                  }
                : {}),
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
  const [outcomes, setOutcomes] = React.useState<Record<string, string>>({})
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
      const { results } = await call<{ results: BatchValidation[] }>(`${base}/validate`, {
        body: { items: requests },
        method: 'POST',
      })
      // A time the browser reads differently (a skipped hour) is the item's problem too.
      const next: Record<string, BatchValidation> = {}
      for (const result of results)
        next[verdictKey(result.itemId, result.channelConnectionId)] = result
      setVerdicts(next)
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

  const schedule = async () => {
    setBusy('schedule')
    // Schedule each item at its saved time: a time changed since the check already dropped its verdicts.
    await settled()
    const results: Record<string, string> = {}
    for (const item of itemsRef.current) {
      if (!item.draftId || !item.draft) continue
      const ids = Object.entries(selected)
        .filter(([key, on]) => on && key.startsWith(`${item.id}/`) && verdicts[key]?.valid)
        .map(([key]) => key.slice(item.id.length + 1))
      if (!ids.length) continue
      const timing = item.timing
      try {
        await draftsApi.schedule(item.draftId, {
          channelConnectionIds: ids,
          version: item.draft.version,
          add: pendingAccounts(item, ids).add,
          naturalPostingTime: false,
          ...(timing.mode === 'queue'
            ? { queue: true, expectedQueueSlot: timing.expectedQueueSlot }
            : {
                localTime: timing.localTime,
                timeZone: timing.timeZone,
                disambiguation: timing.disambiguation,
              }),
        })
        results[item.id] = 'Scheduled'
      } catch (error) {
        // One item's failure keeps the others; it can be corrected and sent again.
        results[item.id] =
          error instanceof DraftRequestError
            ? error.message
            : 'No confirmation received. Check again before retrying.'
      }
      setOutcomes({ ...results })
    }
    await reload()
    setVerdicts({})
    setSelected({})
    setBusy(null)
  }

  const archive = async () => {
    await call(`${base}/archive`, { method: 'POST' })
    window.location.assign('/write')
  }

  const accountName = (id: string) =>
    accounts.find((account) => account.id === id)?.name ?? 'Removed account'
  const unsaved = items.filter((item) => !item.draftId)
  const ready = unsaved.filter((item) => item.media.every((entry) => entry.assetId))
  const drafted = items.filter((item) => item.draftId)
  const checked = Object.keys(verdicts).length > 0
  // The next step is the primary action; the others stay available as outline.
  const next = ready.length ? 'save' : !drafted.length ? null : checked ? 'schedule' : 'check'
  // Smaller action buttons on phones, where the bar stays over the posts.
  const compact = useIsMobile() ? 'sm' : 'default'

  return (
    <Page
      title={batch.title}
      description={
        <>
          Each post here is <strong>its own draft</strong>, up to {ITEM_LIMIT}. To put several files
          in one post, add them to the same CSV row. Times are in {zone}. The batch saves as you go,
          so you can reopen it from Write on any device.
        </>
      }
      actions={
        <>
          <Pill>
            {items.length} of {ITEM_LIMIT} posts
          </Pill>
          <Button
            variant="outline"
            disabled={busy !== null}
            onClick={() => {
              if (window.confirm('Close this batch? Its drafts and scheduled posts stay in Write.'))
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
            </AlertDescription>
          </Alert>
        ) : null}

        {items.length < ITEM_LIMIT ? (
          <Section
            title="Add posts"
            description="Choose files, paste or load a CSV, or both. Nothing is added until you review the preview."
          >
            <Group>
              <Row
                label="Photos and videos"
                description="Each file becomes its own post, or matches a CSV row by its exact name. JPEG, PNG, WebP, GIF, MP4, MOV and WebM; PDFs go to LinkedIn as documents."
              >
                <div
                  className="flex w-full flex-col items-start gap-2 rounded-xl border border-dashed border-border p-4"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault()
                    setChosen(Array.from(event.dataTransfer.files))
                  }}
                >
                  <FilePicker
                    accept={ACCEPT}
                    label="Batch media files"
                    multiple
                    onFiles={setChosen}
                  >
                    Choose files
                  </FilePicker>
                  <p className="text-xs text-muted-foreground">
                    {chosen.length
                      ? `${chosen.length} file${chosen.length === 1 ? '' : 's'} · ${megabytes(chosen.reduce((sum, file) => sum + file.size, 0))}`
                      : 'Or drop files here.'}
                  </p>
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
                description="Used for posts whose row or file has no caption."
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
                {accounts.length ? (
                  accounts.map((account) => (
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
                    <Link href="/workspace/social-sets">Connect an account</Link>
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
                    <>
                      <Button
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => void applyShared('caption')}
                      >
                        Apply shared caption to posts without one
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => void applyShared('accounts')}
                      >
                        Apply shared accounts to unsaved posts
                      </Button>
                    </>
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

        <Section
          title="Times"
          description="Set each post's time below, or fill the times of posts not yet scheduled. Queue slots are a preview: a slot taken before you schedule is refused, not moved."
        >
          <Group>
            <Row>
              <div className="flex flex-wrap items-end gap-3">
                <Label className="grid gap-1 font-normal">
                  Plan
                  <NativeSelect
                    aria-label="Batch time mode"
                    value={timesMode}
                    onChange={(event) => setTimesMode(event.target.value as 'queue' | 'spread')}
                  >
                    <NativeSelectOption value="queue">Fill the queue</NativeSelectOption>
                    <NativeSelectOption value="spread">Spread over days</NativeSelectOption>
                  </NativeSelect>
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
                        onChange={(event) =>
                          setSpread({ ...spread, perDay: Number(event.target.value) })
                        }
                      />
                    </Label>
                    <Label className="grid gap-1 font-normal">
                      Minutes apart
                      <Input
                        className="w-24"
                        type="number"
                        min={1}
                        max={1440}
                        value={spread.spacing}
                        onChange={(event) =>
                          setSpread({ ...spread, spacing: Number(event.target.value) })
                        }
                      />
                    </Label>
                    <Label className="grid gap-1 font-normal">
                      Random shift (minutes)
                      <Input
                        className="w-24"
                        type="number"
                        min={0}
                        max={55}
                        step={5}
                        value={spread.shift}
                        onChange={(event) =>
                          setSpread({ ...spread, shift: Number(event.target.value) })
                        }
                      />
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
                          <a href={`/write/${item.draftId}`} target="_blank" rel="noreferrer">
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
                        ) : (
                          <Textarea
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
                        This brand has no connected accounts.{' '}
                        <Link className="underline" href="/workspace/social-sets">
                          Connect one
                        </Link>{' '}
                        to check and schedule posts.
                      </p>
                    )}
                    {outcomes[item.id] ? (
                      <p
                        role={outcomes[item.id] === 'Scheduled' ? 'status' : 'alert'}
                        className={
                          outcomes[item.id] === 'Scheduled'
                            ? 'text-emerald-700 dark:text-emerald-300'
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
                    unsaved.length > ready.length
                      ? `; ${unsaved.length - ready.length} still uploading or waiting for files`
                      : ''
                  }.`}
            </p>
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
                    disabled={busy !== null || chosenCount === 0}
                    onClick={() => void schedule()}
                  >
                    {busy === 'schedule' ? 'Scheduling…' : `Schedule ${chosenCount} selected`}
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
