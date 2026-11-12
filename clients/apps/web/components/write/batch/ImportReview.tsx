'use client'

import * as React from 'react'
import { ImageIcon, PdfIcon, VideoIcon } from '@/components/platform-shell/icons'
import { Group, Pill } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { BatchItemInput } from '@/lib/api/contracts/content-batches'
import { assetContentUrl } from '@/lib/editor/asset-url'
import { clock, shapeName } from '@/lib/write/media-rules'
import { cn } from '@/lib/utils'

/** A row of the import preview; `files` holds each attachment's file, in order. */
export type Staged = {
  files: (File | undefined)[]
  input: BatchItemInput
  line: number
  problems: string[]
}

/**
 * A file's picture before it is uploaded: an image as itself, a video at its
 * opening frame with its length and shape, a library asset by its thumbnail,
 * and anything else by its kind. Pictures come from this browser's copy of
 * the file, so nothing is uploaded to show them.
 */
export function FileThumb({
  assetId,
  badge = true,
  className,
  file,
}: {
  assetId?: string
  /** Show a video's length and shape over it. */
  badge?: boolean
  className?: string
  file?: File
}) {
  const type = file?.type ?? ''
  const visual = type.startsWith('image/') || type.startsWith('video/')
  const [url, setUrl] = React.useState<string>()
  // A video's length and shape, or an image's shape, once the browser has read them.
  const [facts, setFacts] = React.useState<{ ms?: number; shape: string }>()
  const [broken, setBroken] = React.useState(false)
  React.useEffect(() => {
    if (!file || !visual) return
    const next = URL.createObjectURL(file)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [file, visual])
  const box = cn('relative flex items-center justify-center overflow-hidden bg-muted', className)
  if (file && url && type.startsWith('video/'))
    return (
      <span className={box}>
        {/* ponytail: one <video> per thumbnail; draw posters with captureVideoPoster in a queue if large imports stutter. */}
        <video
          aria-hidden
          className="size-full object-cover"
          muted
          playsInline
          preload="metadata"
          src={`${url}#t=0.1`}
          onLoadedMetadata={(event) => {
            const element = event.currentTarget
            setFacts({
              ms: element.duration * 1000,
              shape: shapeName(element.videoWidth, element.videoHeight),
            })
          }}
        />
        {badge && facts ? <Badge facts={facts} /> : null}
      </span>
    )
  if (file && url && type.startsWith('image/'))
    return (
      <span className={box}>
        <img
          alt=""
          className="size-full object-cover"
          onLoad={(event) =>
            setFacts({
              shape: shapeName(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight),
            })
          }
          src={url}
        />
        {badge && facts ? <Badge facts={facts} /> : null}
      </span>
    )
  if (!file && assetId && !broken)
    return (
      <span className={box}>
        <img
          alt=""
          className="size-full object-cover"
          loading="lazy"
          onError={() => setBroken(true)}
          src={`${assetContentUrl(assetId)}?variant=thumbnail`}
        />
      </span>
    )
  const Icon =
    type === 'application/pdf' ? PdfIcon : type.startsWith('video/') ? VideoIcon : ImageIcon
  return (
    <span className={box}>
      <Icon aria-hidden className="size-6 text-muted-foreground" />
    </span>
  )
}

/** A picture's length and shape, over its corner. */
function Badge({ facts }: { facts: { ms?: number; shape: string } }) {
  return (
    <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[10px] text-white tabular-nums">
      {facts.ms ? `${clock(facts.ms)} · ` : ''}
      {facts.shape}
    </span>
  )
}

/** Where a row stands: ready to add, or what to fix first. */
function RowStatus({ row }: { row: Staged }) {
  return row.problems.length ? (
    <div className="grid justify-items-start gap-1">
      <Pill tone="red">Needs fixing</Pill>
      {row.problems.map((problem) => (
        <p key={problem} role="alert" className="text-label text-destructive">
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
  const [view, setView] = React.useState<'grid' | 'list'>(visual ? 'grid' : 'list')
  const when = (row: Staged) =>
    row.input.timing.localTime
      ? `${row.input.timing.localTime.replace('T', ' ')} (${row.input.timing.timeZone})`
      : 'Time set later'
  const accounts = (row: Staged) =>
    row.input.channelConnectionIds.map(accountName).join(', ') || 'No account'
  return (
    <div className="grid gap-3">
      <div
        aria-label="Show the rows as"
        className="inline-flex self-start justify-self-start rounded-md border border-border p-0.5"
        role="group"
      >
        {(
          [
            ['grid', 'Cards'],
            ['list', 'Table'],
          ] as const
        ).map(([value, label]) => (
          <Button
            aria-pressed={view === value}
            className={cn(
              'h-7 rounded px-2.5 text-label',
              view === value
                ? 'bg-foreground/[0.08] text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
            key={value}
            onClick={() => setView(value)}
            size={null}
            variant="custom"
          >
            {label}
          </Button>
        ))}
      </div>
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
                      <FileThumb
                        assetId={first.assetId}
                        className="size-full"
                        file={row.files[0]}
                      />
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
                    <span className="text-label text-muted-foreground tabular-nums">
                      Row {row.line}
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
                      <div className="flex gap-1">
                        {row.input.media.slice(0, 3).map((media, at) => (
                          <FileThumb
                            assetId={media.assetId}
                            badge={false}
                            className="size-10 rounded-md"
                            file={row.files[at]}
                            key={at}
                          />
                        ))}
                        {row.input.media.length > 3 ? (
                          <span className="self-center text-muted-foreground">
                            +{row.input.media.length - 3}
                          </span>
                        ) : null}
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
