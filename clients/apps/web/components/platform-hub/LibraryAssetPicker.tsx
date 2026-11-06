'use client'

import { CheckIcon } from '@phosphor-icons/react/dist/ssr/Check'
import { useEffect, useId, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { useTRPC, useTRPCClient } from '@/lib/trpc/react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MediaThumb } from '@/components/write/composer/media-thumb'
import { formatBytes } from '@/lib/image-tools/format'
import { draftAssetNode, supportedDraftMedia } from '@/lib/platform/asset-handoff'
import type { DraftChannel } from '@/lib/write/document'
import { DESTINATION_MEDIA, mediaProblems } from '@/lib/write/media-rules'

/** Size and day, which tell two copies of one file apart. */
function assetDetails(asset: { bytes: number; createdAt: Date | string }): string {
  return `${formatBytes(asset.bytes)} · ${new Date(asset.createdAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })}`
}

/** Attach existing immutable workspace assets; the server rechecks access before insertion. */
export function LibraryAssetPicker({
  channel,
  onClose,
  onInsert,
}: {
  /** The platform being edited, whose rules decide what can be picked and how many. */
  channel: DraftChannel
  onClose: () => void
  /** The picked assets, in the order they were picked. */
  onInsert: (nodes: ReturnType<typeof draftAssetNode>[]) => void
}) {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const detailsId = useId()
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const maxMedia = DESTINATION_MEDIA[channel].maxMedia
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 200)
    return () => clearTimeout(timer)
  }, [search])
  const query = useInfiniteQuery(
    trpc.asset.list.infiniteQueryOptions(
      { limit: 24, search: debounced || undefined, sort: 'newest', type: 'all' },
      { getNextPageParam: (page) => page.nextCursor }
    )
  )
  const assets = query.data?.pages.flatMap((page) => page.assets) ?? []
  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : maxMedia === 1
          ? [id]
          : current.length < maxMedia
            ? [...current, id]
            : current
    )
  const insert = async () => {
    const picked = selected.flatMap((id) => assets.filter((item) => item.id === id))
    if (picked.length === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      for (const asset of picked) {
        try {
          await client.asset.signDownload.query({ assetId: asset.id })
        } catch (failure) {
          // Drop what is gone, so attaching the rest needs no untick first.
          setSelected((current) => current.filter((id) => id !== asset.id))
          throw failure
        }
      }
      onInsert(picked.map(draftAssetNode))
      onClose()
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'This asset is no longer available. Choose another asset.'
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Attach from Library</DialogTitle>
        </DialogHeader>
        <Input
          type="search"
          aria-label="Search library assets"
          placeholder="Search media"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value)
            setSelected([])
          }}
        />
        {query.isPending ? (
          <p role="status">Loading assets…</p>
        ) : query.isError ? (
          <div role="alert">
            <p>Library assets could not load.</p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </div>
        ) : assets.length ? (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {assets.map((item) => {
              const supported = supportedDraftMedia(item.mediaType)
              const refused = supported
                ? mediaProblems(channel, [{ mimeType: item.mediaType }])[0]
                : 'Export to PNG, JPEG, WebP, GIF, MP4 or WebM first.'
              const chosen = selected.includes(item.id)
              const name = item.fileName || 'Workspace media'
              return (
                <li key={item.id}>
                  <Button
                    variant="custom"
                    size={null}
                    type="button"
                    aria-label={name}
                    aria-describedby={`${detailsId}-${item.id}`}
                    disabled={Boolean(refused) || busy}
                    aria-pressed={chosen}
                    onClick={() => toggle(item.id)}
                    className="relative flex h-full w-full flex-col gap-2 rounded-lg border p-2 text-start aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:ring-2 aria-pressed:ring-primary disabled:opacity-60"
                  >
                    <MediaThumb
                      assetId={item.id}
                      className="aspect-video w-full object-contain"
                      video={item.mediaType.startsWith('video/')}
                    />
                    {chosen ? (
                      <span className="absolute top-3 right-3 grid size-6 place-items-center rounded-full bg-primary text-primary-foreground">
                        <CheckIcon aria-hidden className="size-4" weight="bold" />
                      </span>
                    ) : null}
                    <span className="w-full truncate text-xs">{name}</span>
                    <span
                      className="w-full text-xs text-muted-foreground"
                      id={`${detailsId}-${item.id}`}
                    >
                      {refused ?? assetDetails(item)}
                    </span>
                  </Button>
                </li>
              )
            })}
          </ul>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {search
              ? 'No assets match this search.'
              : 'No workspace assets yet. Upload media from the composer or save an export from Create.'}
          </p>
        )}
        {query.hasNextPage ? (
          <Button
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            Load more
          </Button>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          {maxMedia > 1 ? (
            <span className="me-auto text-xs text-muted-foreground">Up to {maxMedia}</span>
          ) : null}
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={selected.length === 0 || busy} onClick={() => void insert()}>
            {busy
              ? 'Checking access…'
              : selected.length > 0
                ? `Attach ${selected.length}`
                : 'Attach'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
