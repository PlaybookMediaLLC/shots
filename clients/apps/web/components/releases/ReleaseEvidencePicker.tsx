'use client'

import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import type { QualificationRevision } from 'screenshot-studio-backend-sdk'
import { useTRPC } from '@/lib/trpc/react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'

/** Evidence accepts every uploaded file type; the post attachment picker only accepts media. */
export function ReleaseEvidencePicker({
  selected,
  limit = 200,
  onClose,
  onSelect,
}: {
  limit?: number
  selected: readonly string[]
  onClose: () => void
  onSelect: (ids: string[], sources: QualificationRevision['sourceAssets']) => void
}) {
  const trpc = useTRPC()
  const [picked, setPicked] = useState([...selected])
  const query = useInfiniteQuery(
    trpc.asset.list.infiniteQueryOptions(
      { limit: 24, sort: 'newest', type: 'all' },
      { getNextPageParam: (page) => page.nextCursor }
    )
  )
  const assets = query.data?.pages.flatMap((page) => page.assets) ?? []
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Choose release evidence</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Select existing files from your Library. You can also use source links or a named human
          brief.
        </p>
        {query.isPending ? (
          <p role="status">Loading files…</p>
        ) : query.isError ? (
          <div role="alert">
            <p>Files could not load.</p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              Retry files
            </Button>
          </div>
        ) : assets.length ? (
          <ul className="space-y-3">
            {assets.map((asset) => (
              <li className="flex items-center gap-3" key={asset.id}>
                <Checkbox
                  id={`qualification-asset-${asset.id}`}
                  checked={picked.includes(asset.id)}
                  disabled={!picked.includes(asset.id) && picked.length >= limit}
                  onCheckedChange={(checked) =>
                    setPicked((current) =>
                      checked === true
                        ? [...current, asset.id]
                        : current.filter((id) => id !== asset.id)
                    )
                  }
                />
                <Label className="min-w-0 break-words" htmlFor={`qualification-asset-${asset.id}`}>
                  {asset.fileName || 'Uploaded file'}{' '}
                  <span className="text-xs text-muted-foreground">({asset.mediaType})</span>
                </Label>
              </li>
            ))}
          </ul>
        ) : (
          <p>
            No uploaded files yet. Add files to Library, or use a link or human brief in the form.
          </p>
        )}
        {query.hasNextPage ? (
          <Button
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            More files
          </Button>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              onSelect(
                picked,
                assets
                  .filter((asset) => picked.includes(asset.id))
                  .map((asset) => ({
                    id: asset.id,
                    fileName: asset.fileName || 'Uploaded file',
                    mediaType: asset.mediaType,
                  }))
              )
              onClose()
            }}
          >
            Use {picked.length} selected files
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
