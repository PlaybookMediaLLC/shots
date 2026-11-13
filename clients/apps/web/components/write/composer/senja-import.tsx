'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { importSenjaVideoContract, listSenjaVideosContract } from '@/lib/api/contracts/senja'
import { call } from '@/lib/content-drafts/client'
import { clock } from '@/lib/write/media-rules'

type Video = ReturnType<typeof listSenjaVideosContract.output.parse>['items'][number]
type Imported = ReturnType<typeof importSenjaVideoContract.output.parse>

/**
 * Imports one approved video testimonial from the workspace's Senja project
 * as a workspace asset. The server re-reads the testimonial and stores the
 * video through the usual upload checks; the composer attaches the asset.
 */
export function SenjaImport({
  configured,
  onClose,
  onImported,
}: {
  configured: boolean
  onClose: () => void
  onImported: (asset: { id: string; mediaType: string }) => void
}) {
  const [videos, setVideos] = React.useState<Video[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [importing, setImporting] = React.useState<string | null>(null)
  const load = React.useCallback(() => {
    setError(null)
    setVideos(null)
    call(listSenjaVideosContract.path)
      .then((body) => setVideos(listSenjaVideosContract.output.parse(body).items))
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : 'Senja could not be reached.')
      )
  }, [])
  React.useEffect(() => {
    if (configured) load()
  }, [configured, load])
  const choose = async (video: Video) => {
    setImporting(video.id)
    setError(null)
    try {
      const imported: Imported = importSenjaVideoContract.output.parse(
        await call(importSenjaVideoContract.path, { body: { id: video.id }, method: 'POST' })
      )
      onImported({ id: imported.assetId, mediaType: imported.mediaType })
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The video could not be imported.')
    } finally {
      setImporting(null)
    }
  }
  return (
    <Dialog onOpenChange={(open) => (open || importing ? null : onClose())} open>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{configured ? 'Import from Senja' : 'Senja is not set up'}</DialogTitle>
          <DialogDescription>
            {configured
              ? 'Your Senja project’s newest approved video testimonials. The one you choose becomes a video in this workspace.'
              : 'An owner or admin adds the Senja project’s API key in Settings, under Integrations.'}
          </DialogDescription>
        </DialogHeader>
        {!configured ? null : error ? (
          <div className="grid gap-2">
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
            {videos ? null : (
              <Button className="justify-self-start" onClick={load} size="sm" variant="outline">
                Try again
              </Button>
            )}
          </div>
        ) : null}
        {!configured || error ? null : !videos ? (
          <p className="text-sm text-muted-foreground" role="status">
            Loading testimonials…
          </p>
        ) : videos.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No approved video testimonials in Senja yet.
          </p>
        ) : null}
        {videos?.length ? (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="senja-videos">
            {videos.map((video) => (
              <li key={video.id}>
                <Button
                  className="flex h-auto w-full flex-col items-stretch gap-1 overflow-hidden rounded-md border p-0 text-left"
                  disabled={importing !== null}
                  onClick={() => void choose(video)}
                  size={null}
                  variant="custom"
                >
                  {video.thumbnailUrl ? (
                    <img
                      alt=""
                      className="aspect-video w-full object-cover"
                      src={video.thumbnailUrl}
                    />
                  ) : (
                    <span className="aspect-video w-full bg-muted" />
                  )}
                  <span className="truncate px-2 pb-1.5 text-xs text-foreground">
                    {importing === video.id ? 'Importing…' : video.customerName}
                    {video.durationSeconds !== null && importing !== video.id
                      ? ` · ${clock(video.durationSeconds * 1000)}`
                      : ''}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <DialogFooter>
          <Button disabled={importing !== null} onClick={onClose} variant="outline">
            {configured ? 'Cancel' : 'Close'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
