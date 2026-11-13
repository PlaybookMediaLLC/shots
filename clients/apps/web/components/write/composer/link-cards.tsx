'use client'

import * as React from 'react'
import { linkedInPostIdentity } from '@/lib/write/linkedin-target'
import { LinkPreviewRequestError, requestPreview } from '@/components/link-preview/client'
import { Button } from '@/components/ui/button'
import { linkPreviewAgentSchema } from '@/lib/api/contracts/link-preview'
import { draftsApi } from '@/lib/content-drafts/client'
import { auditLinkPreview, issueSeveritySchema } from '@/lib/link-preview/audit'
import { MAX_GATED_LINKS } from '@/lib/link-preview/gate'
import { POST_COLUMN } from '@/components/drafts/layout'
import { LABELS } from '@/lib/write/media-rules'
import { cn } from '@/lib/utils'
import { linkPreviewSchema, type DraftChannel, type LinkPreview } from '@/lib/write/document'

/** Platforms whose posts show no link card, where looking one up would mislead. */
export const NO_LINK_CARDS: readonly DraftChannel[] = ['instagram', 'tiktok', 'youtube', 'pinterest']

/** HTTPS links in the visible platform version, in document order. */
export function previewLinks(text: string): string[] {
  return [
    ...new Set(
      (text.match(/https:\/\/[^\s<>"']+/g) ?? []).map((url) => url.replace(/[).,!?;]+$/, ''))
    ),
  ]
    .filter((url) => {
      try {
        return (
          new URL(url).hostname.includes('.') && linkPreviewSchema.shape.url.safeParse(url).success
        )
      } catch {
        return false
      }
    })
    .slice(0, 25)
}

/** Stored metadata is shared by the composer and publication preview. */
export function LinkPreviewCard({ card }: { card: LinkPreview }) {
  if (card.removed) return null
  return (
    <div
      className="my-2 overflow-hidden rounded-lg border border-input"
      data-testid="link-preview-card"
    >
      {card.image ? <img alt="" src={card.image} className="max-h-48 w-full object-cover" /> : null}
      <div className="p-3 text-sm">
        <p className="font-medium">{card.title || card.url}</p>
        <p className="line-clamp-3 text-xs text-muted-foreground">{card.description}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">{card.url}</p>
      </div>
    </div>
  )
}

/** The automatic check's answer under a link: its errors, or why the page could not be read. */
function LinkCheckResult({ problem, url }: { problem: string; url: string }) {
  return (
    <p
      role="status"
      className={
        problem ? 'text-xs text-amber-700 dark:text-amber-300' : 'text-xs text-muted-foreground'
      }
    >
      Link check: {problem || 'no problems found.'}{' '}
      <Button asChild className="h-auto p-0 text-xs" size={null} variant="link">
        <a
          href={`/publish/link-checks?${new URLSearchParams({ url })}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Details
        </a>
      </Button>
    </p>
  )
}

/** Fetch Open Graph data once per link and persist deliberate removal choices. */
export function LinkCards({
  text,
  channel,
  cards,
  onChange,
  onQuote,
}: {
  text: string
  channel: DraftChannel
  cards: LinkPreview[]
  onChange: (card: LinkPreview) => void
  onQuote?: (url: string) => void
}) {
  const links = previewLinks(text)
  const key = links.join('\n')
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [retry, setRetry] = React.useState(0)
  const current = React.useEffectEvent(() => cards)
  const save = React.useEffectEvent(onChange)
  const [checks, setChecks] = React.useState<Record<string, string>>({})
  const checked = React.useEffectEvent((url: string) => url in checks)
  const noCards = NO_LINK_CARDS.includes(channel)
  // LinkedIn makes no card from the text and Shots sends none (Posts API, TF-029);
  // its links still open quote drafts and get the page check.
  const plain = channel === 'linkedin'
  // Only Bluesky publishes Shots' card, so only Bluesky can leave it out (TF-029).
  const removable = channel === 'bluesky'
  // Each platform keeps its own cards, so opening another tab looks up what it lacks.
  React.useEffect(() => {
    if (noCards || plain) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      for (const url of key.split('\n').filter(Boolean)) {
        if (current().some((card) => card.url === url)) continue
        void draftsApi
          .linkCard(url)
          .then((card) => {
            if (cancelled) return
            save({
              url,
              title: (card.title ?? '').slice(0, 250),
              description: (card.description ?? '').slice(0, 1000),
              ...(card.image?.startsWith('https://') ? { image: card.image } : {}),
            })
            setErrors((previous) => {
              const next = { ...previous }
              delete next[url]
              return next
            })
          })
          .catch(() => {
            if (!cancelled)
              setErrors((previous) => ({ ...previous, [url]: 'Preview could not be loaded.' }))
          })
      }
    }, 600)
    return () => {
      window.clearTimeout(timer)
      cancelled = true
    }
  }, [channel, key, noCards, plain, retry])
  // A check reads the whole page, so it waits for a longer pause than the card does.
  React.useEffect(() => {
    if (noCards) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      for (const url of key.split('\n').filter(Boolean).slice(0, MAX_GATED_LINKS)) {
        if (checked(url)) continue
        void requestPreview(url, linkPreviewAgentSchema.enum.default, controller.signal)
          .then((preview) =>
            auditLinkPreview(preview)
              .filter((issue) => issue.severity === issueSeveritySchema.enum.error)
              .map((issue) => issue.title)
              .join('; ')
          )
          // A page that can't be read is the answer. A check that could not run (a busy
          // limiter, a timeout) says nothing about the link, so it leaves no result and
          // the next pause tries again.
          .catch((error: unknown) =>
            error instanceof LinkPreviewRequestError && error.status === 422 ? error.message : null
          )
          .then((problem) => {
            if (problem !== null && !controller.signal.aborted)
              setChecks((previous) => ({ ...previous, [url]: problem }))
          })
      }
    }, 1500)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [key, noCards])
  if (!links.length) return null
  if (noCards)
    return (
      <p className={cn('my-2 text-xs text-muted-foreground', POST_COLUMN)} data-testid="no-link-cards">
        {channel === 'youtube'
          ? 'YouTube shows links in the description as plain links, with no preview card.'
          : `Links in ${channel === 'tiktok' ? 'TikTok' : 'Instagram'} captions are not clickable.`}
      </p>
    )
  return (
    <section aria-label="Link previews" className={cn('my-2 space-y-2', POST_COLUMN)}>
      {plain ? (
        <p className="text-xs text-muted-foreground" data-testid="plain-links">
          LinkedIn shows links without a preview card: it makes none from the text, and Shots sends
          none.
        </p>
      ) : removable ? null : (
        <p className="text-xs text-muted-foreground" data-testid="provider-cards">
          {LABELS[channel]} makes its own card from a link on a post without media; its API
          can&apos;t remove it.
        </p>
      )}
      {links.map((url) => {
        const card = plain ? undefined : cards.find((item) => item.url === url)
        const quote =
          Boolean(linkedInPostIdentity(url)) ||
          /^https:\/\/(?:www\.)?(?:(?:x|twitter)\.com\/[^/]+\/status\/\d+|bsky\.app\/profile\/[^/]+\/post\/)/.test(
            url
          ) ||
          /^https:\/\/[^/@:]+\/(?:@[^/]+\/|users\/[^/]+\/statuses\/|statuses\/)\d+$/.test(url)
        return (
          <div key={url}>
            {plain ? null : card?.removed && removable ? (
              <p className="text-xs text-muted-foreground">Preview removed for {url}</p>
            ) : card ? (
              <LinkPreviewCard card={{ ...card, removed: false }} />
            ) : (
              <p role="status" className="text-xs text-muted-foreground">
                {errors[url] || 'Loading link preview…'}
              </p>
            )}
            {checks[url] !== undefined ? <LinkCheckResult problem={checks[url]} url={url} /> : null}
            <div className="flex flex-wrap gap-2">
              {card && removable ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onChange({ ...card, removed: !card.removed })}
                >
                  {card.removed ? 'Restore preview' : 'Remove preview'}
                </Button>
              ) : errors[url] && !plain ? (
                <Button size="sm" variant="ghost" onClick={() => setRetry((value) => value + 1)}>
                  Retry preview
                </Button>
              ) : null}
              {quote && onQuote ? (
                <Button size="sm" variant="ghost" onClick={() => onQuote(url)}>
                  Open as quote draft
                </Button>
              ) : null}
            </div>
          </div>
        )
      })}
    </section>
  )
}
