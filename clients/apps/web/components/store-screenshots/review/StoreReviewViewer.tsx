'use client'

import * as React from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

/** A review as the page receives it: rendered slides with signed URLs, and comments. */
type Review = {
  id: string
  name: string
  versionLabel: string
  projectRevision: number
  createdAt: string
  slides: Array<{ slideId: string; name: string; width: number; height: number; url: string }>
  comments: Array<{ id: string; slideId: string; x: number | null; y: number | null; authorName: string; body: string; resolvedAt: string | null; createdAt: string }>
}

const NAME_KEY = 'shots-review-name'

/**
 * Read-only review: navigate slides, drop a pin on a slide, and comment.
 * Nothing here can edit the project; the page only ever sees rendered
 * images through short-lived signed URLs.
 */
export function StoreReviewViewer({ token, review }: { token: string; review: Review }): React.JSX.Element {
  const [index, setIndex] = React.useState(0)
  const [comments, setComments] = React.useState(review.comments)
  const [pin, setPin] = React.useState<{ x: number; y: number } | null>(null)
  const [name, setName] = React.useState('')
  const [body, setBody] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)
  const slide = review.slides[index]
  const slideComments = comments.filter((comment) => comment.slideId === slide.slideId)

  React.useEffect(() => {
    setName(localStorage.getItem(NAME_KEY) ?? '')
  }, [])

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return
      if (event.key === 'ArrowRight') setIndex((value) => Math.min(review.slides.length - 1, value + 1))
      if (event.key === 'ArrowLeft') setIndex((value) => Math.max(0, value - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [review.slides.length])

  const send = async (event: React.FormEvent) => {
    event.preventDefault()
    setSending(true)
    setError(null)
    try {
      localStorage.setItem(NAME_KEY, name)
      const response = await fetch(`/api/review/${encodeURIComponent(token)}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slideId: slide.slideId, x: pin?.x ?? null, y: pin?.y ?? null, authorName: name, body }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'The comment could not be saved.')
      setComments((current) => [...current, data])
      setBody('')
      setPin(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The comment could not be saved.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="flex items-center justify-between gap-3 border-b border-foreground/10 px-5 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-base font-semibold">{review.name}</h1>
          <p className="text-xs text-muted-foreground">
            Read-only review{review.versionLabel ? ` · ${review.versionLabel}` : ''} · shared {formatDistanceToNow(new Date(review.createdAt), { addSuffix: true })}
          </p>
        </div>
        <span className="rounded-full bg-foreground/[0.06] px-2.5 py-1 text-[11px] text-muted-foreground">You can comment; you cannot edit</span>
      </header>
      <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[1fr_360px]">
        <main className="flex min-h-0 flex-col items-center gap-4 p-5">
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" disabled={index === 0} onClick={() => setIndex(index - 1)} aria-label="Previous slide">
              ←
            </Button>
            <span className="text-sm tabular-nums">
              Slide {index + 1} of {review.slides.length} · {slide.name}
            </span>
            <Button variant="outline" size="sm" disabled={index === review.slides.length - 1} onClick={() => setIndex(index + 1)} aria-label="Next slide">
              →
            </Button>
          </div>
          <div className="relative" style={{ aspectRatio: `${slide.width} / ${slide.height}`, height: 'min(72vh, 900px)' }}>
            <Button variant="custom" size={null}
              type="button"
              aria-label="Click to place a comment pin on this slide"
              className="absolute inset-0 cursor-crosshair overflow-hidden rounded-lg shadow-xl ring-1 ring-foreground/10"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                setPin({ x: Math.round(((event.clientX - rect.left) / rect.width) * 1000) / 10, y: Math.round(((event.clientY - rect.top) / rect.height) * 1000) / 10 })
              }}
            >
              <img src={slide.url} alt={`Slide ${index + 1}: ${slide.name}`} className="h-full w-full object-contain" />
            </Button>
            {slideComments.map((comment, number) =>
              comment.x !== null && comment.y !== null ? (
                <span key={comment.id} className={cn('pointer-events-none absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-[11px] font-semibold text-white shadow', comment.resolvedAt ? 'bg-zinc-400' : 'bg-violet-600')} style={{ left: `${comment.x}%`, top: `${comment.y}%` }}>
                  {number + 1}
                </span>
              ) : null
            )}
            {pin ? <span className="pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-amber-500 shadow" style={{ left: `${pin.x}%`, top: `${pin.y}%` }} /> : null}
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Slides">
            {review.slides.map((item, slideIndex) => (
              <Button variant="custom" size={null} key={item.slideId} type="button" onClick={() => setIndex(slideIndex)} aria-current={slideIndex === index} className={cn('relative h-20 shrink-0 overflow-hidden rounded ring-1', slideIndex === index ? 'ring-2 ring-violet-500' : 'ring-foreground/10 opacity-70')} style={{ aspectRatio: `${item.width} / ${item.height}` }}>
                <img src={item.url} alt={`Slide ${slideIndex + 1}`} className="h-full w-full object-cover" />
                {comments.some((comment) => comment.slideId === item.slideId && !comment.resolvedAt) ? <span className="absolute right-1 top-1 size-2 rounded-full bg-violet-600" aria-label="Has open comments" /> : null}
              </Button>
            ))}
          </div>
        </main>
        <aside className="flex min-h-0 flex-col border-l border-foreground/10" aria-label="Comments">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            <h2 className="text-ui-lg font-semibold">Comments on this slide</h2>
            {slideComments.length === 0 ? <p className="text-xs text-muted-foreground">No comments yet. Click the slide to point at something, then write below.</p> : null}
            {slideComments.map((comment, number) => (
              <article key={comment.id} className={cn('rounded-md border p-2.5 text-sm', comment.resolvedAt ? 'border-foreground/10 opacity-60' : 'border-foreground/15')}>
                <p className="text-xs text-muted-foreground">
                  {comment.x !== null ? `#${number + 1} · ` : ''}
                  {comment.authorName} · {formatDistanceToNow(new Date(comment.createdAt), { addSuffix: true })}
                  {comment.resolvedAt ? ' · resolved' : ''}
                </p>
                <p className="mt-1 whitespace-pre-wrap">{comment.body}</p>
              </article>
            ))}
          </div>
          <form onSubmit={send} className="space-y-2 border-t border-foreground/10 p-4">
            <Input value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} placeholder="Your name" aria-label="Your name" className="h-9 w-full rounded-md border border-foreground/15 bg-background px-3 text-sm" />
            <Textarea value={body} onChange={(event) => setBody(event.target.value)} required maxLength={2000} rows={3} placeholder={pin ? 'Comment on the pinned spot' : 'Comment on this slide'} aria-label="Comment" className="w-full rounded-md border border-foreground/15 bg-background p-2 text-sm" />
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              {pin ? (
                <Button variant="custom" size={null} type="button" className="text-xs underline underline-offset-2" onClick={() => setPin(null)}>
                  Remove pin
                </Button>
              ) : (
                <span className="text-[11px] text-muted-foreground">Tip: click the slide to pin a spot.</span>
              )}
              <Button type="submit" disabled={sending || !name.trim() || !body.trim()}>
                {sending ? 'Sending…' : 'Comment'}
              </Button>
            </div>
          </form>
        </aside>
      </div>
    </div>
  )
}
