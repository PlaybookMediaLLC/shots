'use client'

import { useQuery } from '@tanstack/react-query'
import { draftsApi } from '@/lib/content-drafts/client'

/** The card a link gets on X, Threads or Mastodon, which make it themselves; Bluesky's saved card shows instead when it has one. */
export function PreviewLinkCard({ text }: { text: string }) {
  let url = text.match(/https?:\/\/[^\s<>]+/)?.[0]?.replace(/[).,!?;]+$/, '') ?? ''
  try {
    if (!url || url.length > 2000 || new URL(url).username || new URL(url).password) url = ''
  } catch {
    url = ''
  }
  const query = useQuery({
    queryKey: ['draft-link-preview', url],
    queryFn: () => draftsApi.linkCard(url),
    enabled: !!url && url.length <= 2000,
    staleTime: 5 * 60_000,
    retry: false,
  })
  if (!url) return null
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
      className="mt-2 overflow-hidden rounded-xl border border-input"
      data-testid="post-link-preview"
    >
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
