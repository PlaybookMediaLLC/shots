'use client'

import * as React from 'react'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { ReviewSummary } from '@/lib/api/contracts/store-screenshots'
import { evaluateSlide } from '@/lib/store-screenshots/engine/scene'
import { getStoreTargetOrDefault, targetPixelSize } from '@/lib/store-screenshots/targets'
import { cn } from '@/lib/utils'
import { encodeCanvas, renderSceneToCanvas } from '../../render/capture'
import { useRenderServices } from '../../render/RenderProvider'
import { useEditor, useEditorApi } from '../editor-store'
import type { DialogProps } from './BasicDialogs'
import { blobToBase64, requestJson } from './request'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'

/** Review images are rendered at this width: sharp on a laptop, small to upload. */
const REVIEW_WIDTH = 900

/**
 * Share for review: render the current slides to images, publish them
 * behind a signed read-only link, and work through the comments that come
 * back. Reviewers only ever see the rendered images.
 */
export function ReviewDialog({ open, onOpenChange }: DialogProps): React.JSX.Element {
  const api = useEditorApi()
  const document = useEditor((state) => state.document)
  const targetId = useEditor((state) => state.targetId)
  const locale = useEditor((state) => state.locale)
  const { measurer, resolveAsset, whenAssetsReady } = useRenderServices()
  const [reviews, setReviews] = React.useState<ReviewSummary[] | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [name, setName] = React.useState(document.name)
  const [versionLabel, setVersionLabel] = React.useState('')
  const [progress, setProgress] = React.useState<{ done: number; total: number } | null>(null)
  const [confirmRevoke, setConfirmRevoke] = React.useState<string | null>(null)
  const abortRef = React.useRef<AbortController | null>(null)

  const load = React.useCallback(async () => {
    try {
      const result = await requestJson<{ reviews: ReviewSummary[] }>(`/api/store-screenshots/reviews?projectId=${encodeURIComponent(document.id)}`)
      setReviews(result.reviews)
      setLoadError(null)
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : 'Reviews could not be loaded.')
    }
  }, [document.id])

  React.useEffect(() => {
    if (open) void load()
  }, [open, load])

  const create = async () => {
    const controller = new AbortController()
    abortRef.current = controller
    const target = getStoreTargetOrDefault(targetId)
    const full = targetPixelSize(target)
    const size = { width: REVIEW_WIDTH, height: Math.round((REVIEW_WIDTH * full.height) / full.width) }
    setProgress({ done: 0, total: document.slides.length })
    try {
      await whenAssetsReady(Object.keys(document.assets))
      const slides = []
      for (const [index, slide] of document.slides.entries()) {
        const scene = evaluateSlide(document, index, { size, targetId: target.id, locale, measurer })
        const canvas = await renderSceneToCanvas(scene, resolveAsset, { signal: controller.signal })
        const image = await blobToBase64(await encodeCanvas(canvas, 'jpeg', 0.85))
        const { assetId } = await requestJson<{ assetId: string }>('/api/store-screenshots/reviews/images', {
          body: { name: slide.name || `Slide ${index + 1}`, width: size.width, height: size.height, image },
          signal: controller.signal,
        })
        slides.push({ slideId: slide.id, name: (slide.name || `Slide ${index + 1}`).slice(0, 80), assetId, width: size.width, height: size.height })
        setProgress({ done: index + 1, total: document.slides.length })
      }
      const review = await requestJson<ReviewSummary>('/api/store-screenshots/reviews', {
        body: { projectId: document.id, name: name.trim() || document.name, versionLabel: versionLabel.trim(), projectRevision: document.revision, slides },
        signal: controller.signal,
      })
      setReviews((current) => [review, ...(current ?? [])])
      if (review.url) await navigator.clipboard.writeText(review.url).then(() => toast.success('Review link copied'), () => toast.success('Review link created'))
    } catch (cause) {
      if (controller.signal.aborted) toast('Sharing cancelled.')
      else toast.error('The review could not be created', { description: cause instanceof Error ? cause.message : undefined })
    } finally {
      abortRef.current = null
      setProgress(null)
    }
  }

  const revoke = async (reviewId: string) => {
    try {
      await requestJson(`/api/store-screenshots/reviews/${reviewId}/revoke`, { method: 'POST', body: {} })
      setConfirmRevoke(null)
      toast.success('Link turned off. Anyone who opens it now sees nothing.')
      await load()
    } catch (cause) {
      toast.error('The link could not be turned off', { description: cause instanceof Error ? cause.message : undefined })
    }
  }

  const resolve = async (reviewId: string, commentId: string, resolved: boolean) => {
    // Optimistic: the checkbox answers at once and reverts if the server refuses.
    const mark = (value: boolean) =>
      setReviews((current) =>
        current?.map((review) =>
          review.id === reviewId
            ? { ...review, comments: review.comments.map((comment) => (comment.id === commentId ? { ...comment, resolvedAt: value ? new Date().toISOString() : null } : comment)) }
            : review
        ) ?? null
      )
    mark(resolved)
    try {
      await requestJson(`/api/store-screenshots/reviews/${reviewId}/comments/${commentId}`, { method: 'PUT', body: { resolved } })
    } catch (cause) {
      mark(!resolved)
      toast.error('The comment could not be updated', { description: cause instanceof Error ? cause.message : undefined })
    }
  }

  const showSlide = (slideId: string) => {
    if (!document.slides.some((slide) => slide.id === slideId)) return toast('That slide has since been deleted.')
    api.getState().activateSlide(slideId)
    onOpenChange(false)
  }

  const running = progress !== null

  return (
    <Dialog open={open} onOpenChange={(next) => (running ? undefined : onOpenChange(next))}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] max-h-[90vh] sm:max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Share for review</DialogTitle>
          <DialogDescription>
            Reviewers get a read-only link with images of the current slides. They can comment on a slide; they cannot edit or download your project.
          </DialogDescription>
        </DialogHeader>

        <fieldset disabled={running} className="grid gap-2 sm:grid-cols-[1fr_180px_auto] sm:items-end">
          <Label className="block text-xs">
            <span className="text-muted-foreground">Review name</span>
            <Input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-foreground/15 bg-background px-2 text-sm" />
          </Label>
          <Label className="block text-xs">
            <span className="text-muted-foreground">Version label (optional)</span>
            <Input value={versionLabel} maxLength={80} placeholder="e.g. Draft 2" onChange={(event) => setVersionLabel(event.target.value)} className="mt-1 h-9 w-full rounded-md border border-foreground/15 bg-background px-2 text-sm" />
          </Label>
          <Button onClick={() => void create()}>Create link</Button>
        </fieldset>
        {running ? (
          <div className="flex items-center gap-3 text-xs" role="status">
            <progress className="h-1.5 flex-1" max={progress.total} value={progress.done} aria-label="Uploading slides" />
            <span className="tabular-nums">
              {progress.done} / {progress.total}
            </span>
            <Button variant="outline" size="sm" onClick={() => abortRef.current?.abort()}>
              Cancel
            </Button>
          </div>
        ) : null}

        <section aria-labelledby="review-list" className="space-y-3">
          <h3 id="review-list" className="text-xs font-semibold">
            Links for this project
          </h3>
          {loadError ? (
            <p role="alert" className="text-xs text-destructive">
              {loadError}{' '}
              <Button variant="custom" size={null} type="button" className="underline underline-offset-2" onClick={() => void load()}>
                Try again
              </Button>
            </p>
          ) : null}
          {reviews === null && !loadError ? <p className="text-xs text-muted-foreground">Loading…</p> : null}
          {reviews?.length === 0 ? <p className="text-xs text-muted-foreground">No review links yet.</p> : null}
          {reviews?.map((review) => {
            const open = review.comments.filter((comment) => !comment.resolvedAt).length
            return (
              <article key={review.id} className={cn('space-y-2 rounded-md border p-3', review.revokedAt ? 'border-foreground/10 opacity-60' : 'border-foreground/15')}>
                <header className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-ui-lg font-medium">
                      {review.name}
                      {review.versionLabel ? <span className="text-muted-foreground"> · {review.versionLabel}</span> : null}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {review.slides.length} slides · {formatDistanceToNow(new Date(review.createdAt), { addSuffix: true })}
                      {review.projectRevision !== document.revision ? ' · the project has changed since' : ''}
                      {review.revokedAt ? ' · link turned off' : ''} · {open} open {open === 1 ? 'comment' : 'comments'}
                    </p>
                  </div>
                  {review.url ? (
                    <div className="flex gap-1.5">
                      <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(review.url!).then(() => toast.success('Link copied'))}>
                        Copy link
                      </Button>
                      {confirmRevoke === review.id ? (
                        <>
                          <Button variant="destructive" size="sm" onClick={() => void revoke(review.id)}>
                            Turn off link
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setConfirmRevoke(null)}>
                            Keep
                          </Button>
                        </>
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => setConfirmRevoke(review.id)}>
                          Revoke…
                        </Button>
                      )}
                    </div>
                  ) : null}
                </header>
                {review.url ? (
                  <Input readOnly value={review.url} aria-label={`Review link for ${review.name}`} onFocus={(event) => event.currentTarget.select()} className="h-8 w-full rounded-md border border-foreground/10 bg-foreground/[0.03] px-2 font-mono text-[11px]" />
                ) : null}
                {review.comments.length ? (
                  <ul className="space-y-1.5" aria-label={`Comments on ${review.name}`}>
                    {review.comments.map((comment) => {
                      const slideIndex = document.slides.findIndex((slide) => slide.id === comment.slideId)
                      const slideName = review.slides.find((slide) => slide.slideId === comment.slideId)?.name ?? 'Slide'
                      return (
                        <li key={comment.id} className={cn('rounded border border-foreground/10 p-2 text-xs', comment.resolvedAt && 'opacity-60')}>
                          <div className="flex items-center justify-between gap-2">
                            <Button variant="custom" size={null} type="button" className="truncate text-left font-medium underline-offset-2 hover:underline" onClick={() => showSlide(comment.slideId)}>
                              {slideIndex >= 0 ? `Slide ${slideIndex + 1}` : 'Deleted slide'} · {slideName}
                              {comment.x !== null && comment.y !== null ? ` · pinned at ${Math.round(comment.x)}%, ${Math.round(comment.y)}%` : ''}
                            </Button>
                            <Label className="flex shrink-0 items-center gap-1 text-[11px]">
                              <Checkbox  checked={Boolean(comment.resolvedAt)} onCheckedChange={(checked) => void resolve(review.id, comment.id, (checked === true))} />
                              Resolved
                            </Label>
                          </div>
                          <p className="mt-1 whitespace-pre-wrap">{comment.body}</p>
                          <p className="mt-1 text-[10px] text-muted-foreground">
                            {comment.authorName} · {formatDistanceToNow(new Date(comment.createdAt), { addSuffix: true })}
                          </p>
                        </li>
                      )
                    })}
                  </ul>
                ) : null}
              </article>
            )
          })}
        </section>
      </DialogContent>
    </Dialog>
  )
}
