'use client'

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { draftsApi } from '@/lib/content-drafts/client'
import { Button } from '@/components/ui/button'

/** A dismissible local OG preview; provider-generated cards remain controlled by the provider. */
export function PreviewLinkCard({ text }: { text: string }) {
  let url = text.match(/https?:\/\/[^\s<>]+/)?.[0]?.replace(/[).,!?;]+$/, '') ?? ''
  try {
    if (!url || url.length > 2000 || new URL(url).username || new URL(url).password) url = ''
  } catch {
    url = ''
  }
  const [dismissed, setDismissed] = useState('')
  const query = useQuery({
    queryKey: ['draft-link-preview', url],
    queryFn: () => draftsApi.linkCard(url),
    enabled: !!url && url.length <= 2000 && dismissed !== url,
    staleTime: 5 * 60_000,
    retry: false,
  })
  if (!url) return null
  if (dismissed === url)
    return (
      <div className="mt-2 text-xs text-muted-foreground">
        <span>Preview hidden here. The platform may still show a link card.</span>{' '}
        <Button size={null} variant="custom" onClick={() => setDismissed('')}>
          Show link preview
        </Button>
      </div>
    )
  if (query.isPending)
    return <p className="mt-2 text-xs text-muted-foreground">Loading link preview…</p>
  if (!query.data)
    return (
      <p className="mt-2 text-xs text-muted-foreground">
        Link preview unavailable. The link remains in your post.
      </p>
    )
  const card = query.data
  return (
    <div
      className="group relative mt-2 overflow-hidden rounded-xl border border-input"
      data-testid="post-link-preview"
    >
      <Button
        aria-label="Hide link preview"
        title="Hide this preview; the platform controls its published link card"
        className="absolute right-1 top-1 z-10 rounded-full bg-black/80 px-2 text-white md:opacity-0 md:group-hover:opacity-100 focus:opacity-100"
        size={null}
        variant="custom"
        onClick={() => setDismissed(url)}
      >
        ×
      </Button>
      {card.image ? (
        <img
          alt=""
          className="aspect-[1.91] w-full object-cover"
          src={`/api/link-preview/image?${new URLSearchParams({ url: card.image })}`}
        />
      ) : null}
      <div className="p-3">
        <p className="text-xs text-muted-foreground">{card.siteName || new URL(url).hostname}</p>
        <p className="line-clamp-2 text-ui-lg font-medium text-foreground">{card.title || url}</p>
        {card.description ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">{card.description}</p>
        ) : null}
      </div>
    </div>
  )
}
