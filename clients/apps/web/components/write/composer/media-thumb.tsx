'use client'

import * as React from 'react'
import { assetContentUrl } from '@/lib/editor/services'
import { cn } from '@/lib/utils'

/**
 * A small preview of a stored asset: the image thumbnail, or a video's opening
 * frame. A preview that cannot load names the kind of media, never its MIME type.
 */
export function MediaThumb({
  alt = '',
  assetId,
  className,
  poster,
  video,
}: {
  alt?: string
  assetId: string
  className?: string
  /** The stored opening frame of a video, which spares downloading the video itself. */
  poster?: string
  video: boolean
}) {
  const [failed, setFailed] = React.useState(false)
  const box = cn('bg-muted object-cover', className)
  if (failed)
    return (
      <span className={cn(box, 'grid place-items-center text-xs text-muted-foreground')}>
        {video ? 'Video' : 'Image'}
      </span>
    )
  return video && !poster ? (
    <video
      aria-label={alt || undefined}
      className={box}
      draggable={false}
      muted
      onError={() => setFailed(true)}
      playsInline
      preload="metadata"
      // Opening just past the start shows a frame: many videos begin on black.
      src={`${assetContentUrl(assetId)}#t=0.1`}
    />
  ) : (
    <img
      alt={alt}
      className={box}
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
      src={`${assetContentUrl(poster ?? assetId)}?variant=thumbnail`}
    />
  )
}
