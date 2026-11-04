'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { assetContentUrl } from '@/lib/editor/services'

/** LinkedIn's limit on a document's pages. */
const PAGE_LIMIT = 300

type Loaded = { count: number; destroy: () => Promise<void>; render: (page: number, canvas: HTMLCanvasElement) => { promise: Promise<void>; cancel: () => void } }

/** Open a PDF with pdf.js, loaded on first use; its worker ships beside the app. */
async function openPdf(url: string): Promise<Loaded> {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).toString()
  const loading = pdfjs.getDocument({ url })
  const document = await loading.promise
  return {
    count: document.numPages,
    destroy: () => loading.destroy(),
    render: (page, canvas) => {
      let cancelled = false
      let task: ReturnType<Awaited<ReturnType<typeof document.getPage>>['render']> | undefined
      const promise = (async () => {
      const loaded = await document.getPage(page)
      if (cancelled) return
      const viewport = loaded.getViewport({ scale: 1 })
      const scale = Math.min(2, 640 / viewport.width)
      const scaled = loaded.getViewport({ scale })
      canvas.width = scaled.width
      canvas.height = scaled.height
      task = loaded.render({ canvas, viewport: scaled })
      await task.promise
      })()
      return { promise, cancel: () => { cancelled = true; task?.cancel() } }
    },
  }
}

/**
 * A LinkedIn PDF carousel's pages, one at a time with previous and next, the
 * page count checked against LinkedIn's 300, and shaded safe areas where
 * LinkedIn overlays its own controls. A PDF that cannot be read says so.
 */
export function PdfCarousel({ assetId }: { assetId: string }) {
  const canvas = React.useRef<HTMLCanvasElement>(null)
  const [pdf, setPdf] = React.useState<Loaded | null>(null)
  const [page, setPage] = React.useState(1)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => {
    let current = true
    let opened: Loaded | null = null
    setPage(1)
    setPdf(null)
    setError(null)
    openPdf(assetContentUrl(assetId))
      .then((loaded) => { opened = loaded; if (current) setPdf(loaded); else void loaded.destroy() })
      .catch(
        () =>
          current && setError('This PDF could not be read. Upload it again, or use another file.')
      )
    return () => {
      current = false
      if (opened) void opened.destroy()
    }
  }, [assetId])
  React.useEffect(() => {
    if (!pdf || !canvas.current) return
    let active = true
    const task = pdf.render(page, canvas.current)
    task.promise.catch(() => { if (active) setError(`Page ${page} could not be drawn.`) })
    return () => { active = false; task.cancel() }
  }, [page, pdf])
  if (error) {
    return (
      <p className="rounded-lg border border-red-400/30 p-3 text-sm text-red-700 dark:text-red-200" role="alert">
        {error}
      </p>
    )
  }
  return (
    <div className="grid gap-2" data-testid="pdf-carousel">
      <div className="relative mx-auto w-full max-w-md overflow-hidden rounded-lg bg-foreground/5">
        {pdf ? null : <p className="p-8 text-center text-sm text-muted-foreground">Reading the PDF…</p>}
        <canvas aria-label={`Document preview, page ${page}. Use the original PDF for selectable text.`} className="block w-full" ref={canvas} role="img" />
        {pdf ? (
          <>
            {/* Where LinkedIn draws the page counter and the next arrow. */}
            <span
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-[9%] bg-black/35"
            />
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 right-0 w-[12%] bg-black/25"
            />
            <span className="pointer-events-none absolute top-1 left-2 text-label text-white/80">
              {page} / {pdf.count}
            </span>
          </>
        ) : null}
      </div>
      {pdf ? (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <Button
            disabled={page === 1}
            onClick={() => setPage(page - 1)}
            size="sm"
            type="button"
            variant="ghost"
          >
            ← Previous
          </Button>
          <span data-testid="pdf-page-count">
            {pdf.count} page{pdf.count === 1 ? '' : 's'}
            {pdf.count > PAGE_LIMIT ? ` — over LinkedIn's ${PAGE_LIMIT}` : ''}
          </span>
          <Button
            disabled={page === pdf.count}
            onClick={() => setPage(page + 1)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Next →
          </Button>
        </div>
      ) : null}
    </div>
  )
}
