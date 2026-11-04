'use client'

import { Input } from '@/components/ui/input'
import { LibraryIcon as Album02Icon } from '@/components/platform-shell/icons'
import { MoreIcon as MoreHorizontalIcon } from '@/components/platform-shell/icons'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { TRPCClientError } from '@trpc/client'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { EmptyState } from '@/components/platform-ui'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTRPC, useTRPCClient } from '@/lib/trpc/react'
import { cn } from '@/lib/utils'
import { getErrorMessage } from './settings-client'
import { createWritingDraft } from '@/components/write/pending-draft'
import { draftAssetNode, supportedDraftMedia } from '@/lib/platform/asset-handoff'
import { postBreak } from '@/lib/write/versions'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'

/**
 * The assets a workspace has collected.
 *
 * Until now a saved export had nowhere to appear, so an account gave a
 * user nothing to look at. This is where saved work becomes visible to
 * the team that owns it.
 */

type AssetSummary = {
  fileName?: string
  bytes: number
  createdAt: string | Date
  height: number | null
  id: string
  mediaType: string
  width: number | null
}

type TypeFilter = 'all' | 'image' | 'video'

const PAGE_SIZE = 24
const TYPE_FILTERS: { label: string; value: TypeFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Images', value: 'image' },
  { label: 'Videos', value: 'video' },
]

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDimensions(asset: AssetSummary): string | null {
  return asset.width && asset.height ? `${asset.width}×${asset.height}` : null
}

/** "image/png" → "PNG image". */
function describeType(mediaType: string): string {
  const [kind, subtype] = mediaType.split('/')
  return `${(subtype ?? '').replace(/^x-/, '').toUpperCase()} ${kind}`.trim()
}

/** Stable private URLs avoid reusing expired signatures and resize image previews. */
function AssetPreview({
  asset,
  onMetadataAvailable,
}: {
  asset: AssetSummary
  onMetadataAvailable: () => void
}) {
  const notified = useRef(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const isImage = asset.mediaType.startsWith('image/')
  const isVideo = asset.mediaType.startsWith('video/')
  const url = `/api/v1/assets/${asset.id}/content?${isImage ? 'variant=thumbnail&' : ''}retry=${attempt}`

  return (
    <div className="relative grid aspect-[16/10] place-items-center overflow-hidden bg-[radial-gradient(circle_at_center,#1a1a1a,#0c0c0c)]">
      {failed ? (
        <div role="status" className="space-y-2 p-3 text-center text-sm text-muted-foreground">
          <p>Preview could not load. The saved asset is unchanged.</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setAttempt((value) => value + 1)
              setFailed(false)
            }}
          >
            Retry preview
          </Button>
        </div>
      ) : isImage ? (
        // Private endpoint: next/image's shared optimizer must not cache tenant content.
        <img
          alt={`${describeType(asset.mediaType)} preview`}
          className="absolute inset-0 size-full object-contain p-3"
          loading="lazy"
          src={url}
          onError={() => setFailed(true)}
          onLoad={() => {
            if ((!asset.width || !asset.height) && !notified.current) {
              notified.current = true
              onMetadataAvailable()
            }
          }}
        />
      ) : isVideo ? (
        <video
          className="absolute inset-0 size-full object-contain"
          muted
          preload="none"
          controls
          src={url}
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="text-4xl text-foreground/65" aria-label={describeType(asset.mediaType)}>
          {asset.mediaType.startsWith('font/') ? 'Aa' : 'File'}
        </span>
      )}
    </div>
  )
}

export function WorkspaceAssets({
  canStartPost = false,
}: {
  /** The member may write drafts here, so an image or video can start a new post. */
  canStartPost?: boolean
} = {}) {
  const router = useRouter()
  const trpcClient = useTRPCClient()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const searchParams = useSearchParams()
  const search = searchParams.get('search') ?? ''
  const classificationParam = searchParams.get('classification')
  const classification =
    classificationParam === 'input' || classificationParam === 'export'
      ? classificationParam
      : undefined
  const typeParam = searchParams.get('type')
  const typeFilter: TypeFilter = typeParam === 'image' || typeParam === 'video' ? typeParam : 'all'
  const sort = searchParams.get('sort') === 'oldest' ? 'oldest' : 'newest'
  const options = trpc.asset.list.infiniteQueryOptions(
    { limit: PAGE_SIZE, type: typeFilter, sort, search: search || undefined, classification },
    {
      getNextPageParam: (page) => page.nextCursor,
      // Client-side Back remounts from cache; a save made elsewhere must still show.
      refetchOnMount: 'always',
    }
  )
  const query = useInfiniteQuery(options)
  const assets = useMemo(() => query.data?.pages.flatMap((page) => page.assets) ?? [], [query.data])
  const isLoading = query.isPending
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const deleting = useRef(false)
  const metadataRefresh = useRef<ReturnType<typeof setTimeout> | null>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)

  function refreshMetadata(): void {
    if (metadataRefresh.current) clearTimeout(metadataRefresh.current)
    metadataRefresh.current = setTimeout(() => {
      void queryClient.invalidateQueries(trpc.asset.list.pathFilter())
    }, 250)
  }

  useEffect(
    () => () => {
      if (metadataRefresh.current) clearTimeout(metadataRefresh.current)
    },
    []
  )

  useEffect(() => {
    const refresh = (event: PageTransitionEvent) => {
      if (event.persisted) void queryClient.invalidateQueries(trpc.asset.list.pathFilter())
    }
    window.addEventListener('pageshow', refresh)
    return () => window.removeEventListener('pageshow', refresh)
  }, [queryClient, trpc])

  function updateView(key: 'type' | 'sort' | 'search' | 'classification', value: string): void {
    const params = new URLSearchParams(searchParams.toString())
    params.set(key, value)
    window.history.replaceState(null, '', `?${params}`)
  }

  async function handleOpen(assetId: string): Promise<void> {
    try {
      const { downloadUrl } = await trpcClient.asset.signDownload.query({ assetId })
      window.open(downloadUrl, '_blank', 'noopener,noreferrer')
    } catch (requestError) {
      toast.error('Could not open the asset', { description: getErrorMessage(requestError) })
    }
  }

  async function handleDelete(assetId: string): Promise<void> {
    if (deleting.current) return
    deleting.current = true
    setDeletingId(assetId)
    let alreadyDeleted = false
    try {
      try {
        await trpcClient.asset.delete.mutate({ assetId })
      } catch (requestError) {
        // A teammate may already have deleted the asset. The desired state is reached.
        if (!(requestError instanceof TRPCClientError) || requestError.data?.code !== 'NOT_FOUND')
          throw requestError
        alreadyDeleted = true
      }
      queryClient.setQueryData(options.queryKey, (current) =>
        current
          ? {
              ...current,
              pages: current.pages.map((page) => ({
                ...page,
                assets: page.assets.filter((asset) => asset.id !== assetId),
              })),
            }
          : current
      )
      toast.success('Asset deleted')
      if (alreadyDeleted) await queryClient.invalidateQueries(trpc.asset.list.pathFilter())
    } catch (requestError) {
      toast.error('Could not delete the asset', { description: getErrorMessage(requestError) })
    } finally {
      deleting.current = false
      setDeletingId(null)
      setConfirmingDeleteId(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          aria-label="Filter by type"
          className="inline-flex w-fit rounded-lg bg-foreground/[0.03] p-0.5 ring-1 ring-foreground/[0.08]"
          role="group"
        >
          {TYPE_FILTERS.map((filter) => (
            <Button
              variant="custom"
              size={null}
              aria-pressed={typeFilter === filter.value}
              className={cn(
                'rounded-md px-3 py-1 text-sm font-medium transition-colors',
                typeFilter === filter.value
                  ? 'bg-foreground/[0.08] text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              key={filter.value}
              onClick={() => updateView('type', filter.value)}
              type="button"
            >
              {filter.label}
            </Button>
          ))}
        </div>
        <Label className="flex items-center gap-2 text-sm text-muted-foreground">
          Sort
          <Select onValueChange={(nextValue) => updateView('sort', nextValue)} value={sort}>
            <SelectTrigger className="h-8 rounded-lg bg-foreground/[0.03] px-2 text-sm text-foreground ring-1 ring-foreground/[0.08] outline-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest first</SelectItem>
              <SelectItem value="oldest">Oldest first</SelectItem>
            </SelectContent>
          </Select>
        </Label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="max-w-sm"
          type="search"
          placeholder="Search filenames"
          aria-label="Search assets by filename"
          value={search}
          maxLength={200}
          onChange={(event) => updateView('search', event.target.value)}
        />
        <Select
          value={classification ?? 'all'}
          onValueChange={(value) => updateView('classification', value)}
        >
          <SelectTrigger aria-label="Asset source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="export">Saved exports</SelectItem>
            <SelectItem value="input">Uploaded originals</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Files in this workspace are shared with its members.
        </p>
      </div>
      {query.error ? (
        <Alert variant="destructive">
          <AlertDescription>
            {getErrorMessage(query.error)}{' '}
            <Button variant="ghost" onClick={() => void query.refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {isLoading && assets.length === 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => (
            <li
              className="aspect-[16/12] animate-pulse rounded-xl bg-foreground/[0.03] ring-1 ring-foreground/[0.06]"
              key={index}
            />
          ))}
        </ul>
      ) : assets.length === 0 && !query.error ? (
        <EmptyState
          action={<ButtonLink href="/">Open the editor</ButtonLink>}
          description={
            typeFilter === 'video'
              ? 'Export a video in the editor and choose Save to workspace to keep it here for your team.'
              : 'Compose a screenshot in the editor and choose Save to workspace to keep it here for your team.'
          }
          icon={Album02Icon}
          title={
            typeFilter === 'all'
              ? 'No saved assets yet'
              : `No ${typeFilter === 'video' ? 'videos' : 'images'} saved yet`
          }
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {assets.map((asset) => {
            const dimensions = formatDimensions(asset)
            const isImage = asset.mediaType.startsWith('image/')
            const isConfirmingDelete = confirmingDeleteId === asset.id
            const isDeleting = deletingId === asset.id
            return (
              <li
                className="group overflow-hidden rounded-xl bg-foreground/[0.02] ring-1 ring-foreground/[0.08] transition hover:ring-foreground/[0.16]"
                key={asset.id}
              >
                {asset.mediaType.startsWith('video/') ? (
                  <AssetPreview asset={asset} onMetadataAvailable={refreshMetadata} />
                ) : (
                  <a
                    className="block focus-visible:ring-2"
                    href={`/api/v1/assets/${asset.id}/content`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open ${asset.fileName || describeType(asset.mediaType)}`}
                  >
                    <AssetPreview asset={asset} onMetadataAvailable={refreshMetadata} />
                  </a>
                )}
                <div className="flex items-start justify-between gap-3 border-t border-foreground/[0.06] px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {asset.fileName ||
                        `${describeType(asset.mediaType)} · ${asset.id.slice(0, 8)}`}
                    </p>
                    {asset.projectName ? (
                      <a
                        className="block truncate text-xs text-primary underline"
                        href={`/?project=${asset.projectId}`}
                      >
                        From {asset.projectName}
                      </a>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      {asset.classification === 'export'
                        ? 'Saved export'
                        : asset.classification === 'input'
                          ? 'Uploaded original'
                          : 'Workspace asset'}
                      {asset.uploadedBy ? ` · ${asset.uploadedBy}` : ''}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {[dimensions, formatBytes(asset.bytes)].filter(Boolean).join(' · ')}
                      {' · '}
                      {new Date(asset.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="custom"
                        size={null}
                        aria-label={`Actions for ${describeType(asset.mediaType)} ${asset.id.slice(0, 8)}`}
                        className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-60 transition hover:bg-foreground/[0.06] hover:text-foreground hover:opacity-100 group-hover:opacity-100"
                        type="button"
                      >
                        <MoreHorizontalIcon size={16} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      className="w-44"
                      onCloseAutoFocus={(event) => {
                        if (confirmingDeleteId === asset.id) {
                          event.preventDefault()
                          confirmButton.current?.focus()
                        }
                      }}
                    >
                      {asset.projectId ? (
                        <DropdownMenuItem asChild>
                          <a href={`/?project=${asset.projectId}`}>Open source project</a>
                        </DropdownMenuItem>
                      ) : null}
                      {isImage ? (
                        <DropdownMenuItem asChild>
                          {/* The editor reads this parameter on load and pulls
                              the asset onto the canvas for another pass. */}
                          <a href={`/?asset=${asset.id}`}>Use image in new design</a>
                        </DropdownMenuItem>
                      ) : null}
                      {canStartPost && supportedDraftMedia(asset.mediaType) ? (
                        <DropdownMenuItem
                          onSelect={() =>
                            // The draft references the asset itself, as Attach from Library does.
                            void createWritingDraft(
                              {
                                assetIds: [asset.id],
                                body: [
                                  postBreak(),
                                  { type: 'p', children: [{ text: '' }] },
                                  draftAssetNode(asset),
                                ],
                              },
                              (id) => router.push(`/publish/${encodeURIComponent(id)}`)
                            )
                          }
                        >
                          Use in a new post
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem onSelect={() => void handleOpen(asset.id)}>
                        Download
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => setConfirmingDeleteId(asset.id)}
                        variant="destructive"
                      >
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {isConfirmingDelete ? (
                  <div className="flex items-center justify-between gap-2 border-t border-foreground/[0.06] bg-red-500/[0.06] px-4 py-2.5 text-sm">
                    <span className="text-red-700 dark:text-red-300">Delete this asset?</span>
                    <span className="flex gap-1.5">
                      <Button
                        onClick={() => setConfirmingDeleteId(null)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Cancel
                      </Button>
                      <Button
                        ref={confirmButton}
                        disabled={isDeleting}
                        onClick={() => void handleDelete(asset.id)}
                        size="sm"
                        type="button"
                        variant="destructive"
                      >
                        {isDeleting ? 'Deleting…' : 'Confirm delete'}
                      </Button>
                    </span>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      {query.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            className="rounded-lg"
            disabled={query.isFetching}
            onClick={() => void query.fetchNextPage()}
            type="button"
            variant="outline"
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
