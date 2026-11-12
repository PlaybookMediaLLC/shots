'use client'

import * as React from 'react'
import { ImageIcon, PdfIcon, VideoIcon } from '@/components/platform-shell/icons'
import { Group, Pill } from '@/components/platform-ui'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { BatchItemInput } from '@/lib/api/contracts/content-batches'
import { clock, shapeName } from '@/lib/write/media-rules'
import { captureVideoFrame, type VideoFrame } from '@/lib/workspace/video-poster'
import { cn } from '@/lib/utils'
import { Segmented } from './Segmented'

/** A row of the import preview; `files` holds each attachment's file, in order. */
export type Staged = {
  files: (File | undefined)[]
  input: BatchItemInput
  line: number
  problems: string[]
}

// Each video is read once per page, three at a time: a decoder holds tens of
// megabytes, and a few hundred at once stop loading at all. A reader that
// finishes hands its place straight to the next one waiting.
const frames = new WeakMap<File, Promise<VideoFrame | null>>()
let reading = 0
const waiting: (() => void)[] = []
function videoFrame(file: File): Promise<VideoFrame | null> {
  let frame = frames.get(file)
  if (!frame) {
    frame = (async () => {
      if (reading >= 3) await new Promise<void>((resolve) => waiting.push(resolve))
      else reading += 1
      try {
        return await captureVideoFrame(file)
      } catch {
        return null
      } finally {
        const next = waiting.shift()
        if (next) next()
        else reading -= 1
      }
    })()
    frames.set(file, frame)
  }
  return frame
}

/**
 * A file's picture before it is uploaded: an image as itself, a video by its
 * opening frame, each with its shape and a video's length. The picture comes
 * from this browser's copy of the file, so nothing uploads to show it. A file
 * the browser cannot draw, a library asset (its kind is not known here, and a
 * thumbnail request for a video would read the whole file) and anything else
 * show the icon of their kind.
 */
export function FileThumb({
  badge = true,
  className,
  file,
}: {
  /** Show the shape, and a video's length, over the picture. */
  badge?: boolean
  className?: string
  file?: File
}) {
  const type = file?.type ?? ''
  const video = type.startsWith('video/')
  const visual = video || type.startsWith('image/')
  const [url, setUrl] = React.useState<string>()
  // The shape, and a video's length, once the browser has read the file.
  const [facts, setFacts] = React.useState<{ ms?: number; shape: string }>()
  const [broken, setBroken] = React.useState(false)
  React.useEffect(() => {
    if (!file || !visual) return
    if (!video) {
      const next = URL.createObjectURL(file)
      setUrl(next)
      return () => URL.revokeObjectURL(next)
    }
    let live = true
    let shown: string | undefined
    void videoFrame(file).then((frame) => {
      if (!live) return
      if (!frame) return setBroken(true)
      shown = URL.createObjectURL(frame.poster)
      setUrl(shown)
      setFacts({
        ms: frame.durationMs ?? undefined,
        shape: shapeName(frame.width, frame.height),
      })
    })
    return () => {
      live = false
      if (shown) URL.revokeObjectURL(shown)
    }
  }, [file, video, visual])
  const box = cn('relative flex items-center justify-center overflow-hidden bg-muted', className)
  if (url && visual && !broken)
    return (
      <span className={box}>
        <img
          alt=""
          className="size-full object-cover"
          onError={() => setBroken(true)}
          onLoad={(event) => {
            // A video's facts came with its frame; an image's come from the image.
            if (!video)
              setFacts({
                shape: shapeName(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight),
              })
          }}
          src={url}
        />
        {badge && facts ? (
          <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[10px] text-white tabular-nums">
            {facts.ms ? `${clock(facts.ms)} · ` : ''}
            {facts.shape}
          </span>
        ) : null}
      </span>
    )
  const Icon = type === 'application/pdf' ? PdfIcon : video ? VideoIcon : ImageIcon
  return (
    <span className={box}>
      <Icon aria-hidden className="size-6 text-muted-foreground" />
    </span>
  )
}

/** What a row's attachment is called: its file name, or its library asset ID. */
const mediaName = (media: Staged['input']['media'][number]) => media.fileName ?? media.assetId ?? ''

/** Where a row stands: ready to add, or what to fix first. */
function RowStatus({ row }: { row: Staged }) {
  return row.problems.length ? (
    <div className="grid justify-items-start gap-1">
      <Pill tone="red">Needs fixing</Pill>
      {row.problems.map((problem) => (
        <p key={problem} className="text-label text-destructive">
          {problem}
        </p>
      ))}
    </div>
  ) : (
    <div>
      <Pill tone="green">Ready</Pill>
    </div>
  )
}

/**
 * The rows an import would add, before anything is added: as cards with each
 * post's first picture, or as a table. Cards lead when the rows carry files.
 */
export function ImportReview({
  accountName,
  rows,
}: {
  accountName: (id: string) => string
  rows: readonly Staged[]
}) {
  const visual = rows.some((row) => row.input.media.length > 0)
  // Cards lead for rows with files until a view is picked, preview after preview.
  const [picked, setView] = React.useState<'grid' | 'list'>()
  const view = picked ?? (visual ? 'grid' : 'list')
  const when = (row: Staged) =>
    row.input.timing.localTime
      ? `${row.input.timing.localTime.replace('T', ' ')} (${row.input.timing.timeZone})`
      : 'Time set later'
  const accounts = (row: Staged) =>
    row.input.channelConnectionIds.map(accountName).join(', ') || 'No account'
  return (
    <div className="grid gap-3">
      <Segmented
        label="Show the rows as"
        onChange={setView}
        options={[
          ['grid', 'Cards'],
          ['list', 'Table'],
        ]}
        value={view}
      />
      {view === 'grid' ? (
        <div className="@container">
          <ul
            aria-label="Rows to add"
            className="grid grid-cols-2 gap-3 @md:grid-cols-3 @2xl:grid-cols-4"
          >
            {rows.map((row) => {
              const [first] = row.input.media
              return (
                <li
                  className="grid min-w-0 content-start overflow-hidden rounded-xl border border-border bg-card"
                  key={row.input.importKey}
                >
                  <div className="relative aspect-[4/5]">
                    {first ? (
                      <FileThumb className="size-full" file={row.files[0]} />
                    ) : (
                      <p className="line-clamp-[8] size-full bg-muted/50 p-3 text-ui whitespace-pre-wrap">
                        {row.input.caption || 'No caption'}
                      </p>
                    )}
                    {row.input.media.length > 1 ? (
                      <span className="absolute top-1.5 right-1.5 rounded bg-black/70 px-1.5 text-[10px] text-white tabular-nums">
                        +{row.input.media.length - 1}
                      </span>
                    ) : null}
                  </div>
                  <div className="grid gap-1.5 p-3">
                    <span
                      className="truncate text-label text-muted-foreground tabular-nums"
                      title={first ? mediaName(first) : undefined}
                    >
                      Row {row.line}
                      {first ? ` · ${mediaName(first)}` : ''}
                    </span>
                    {first ? (
                      <p className="line-clamp-2 text-ui">
                        {row.input.caption || (
                          <span className="text-muted-foreground">No caption</span>
                        )}
                      </p>
                    ) : null}
                    <p className="truncate text-label text-muted-foreground" title={accounts(row)}>
                      {accounts(row)}
                    </p>
                    <p className="text-label text-muted-foreground">{when(row)}</p>
                    <RowStatus row={row} />
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      ) : (
        <Group>
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead>Row</TableHead>
                <TableHead>Media</TableHead>
                <TableHead>Caption</TableHead>
                <TableHead>Accounts</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.input.importKey} className="align-top">
                  <TableCell>{row.line}</TableCell>
                  <TableCell>
                    {row.input.media.length ? (
                      <div className="flex items-center gap-1">
                        {row.input.media.slice(0, 3).map((media, at) => (
                          <FileThumb
                            badge={false}
                            className="size-10 rounded-md"
                            file={row.files[at]}
                            key={at}
                          />
                        ))}
                        <span
                          className="ms-1 max-w-32 truncate text-muted-foreground"
                          title={row.input.media.map(mediaName).join(', ')}
                        >
                          {mediaName(row.input.media[0]!)}
                          {row.input.media.length > 1 ? ` +${row.input.media.length - 1}` : ''}
                        </span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-64 truncate">
                    {row.input.caption || <span className="text-muted-foreground">No caption</span>}
                  </TableCell>
                  <TableCell className="max-w-48 truncate" title={accounts(row)}>
                    {accounts(row)}
                  </TableCell>
                  <TableCell>{when(row)}</TableCell>
                  <TableCell className="whitespace-normal">
                    <RowStatus row={row} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Group>
      )}
    </div>
  )
}
