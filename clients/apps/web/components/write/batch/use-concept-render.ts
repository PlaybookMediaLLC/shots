'use client'

import * as React from 'react'
import { toast } from 'sonner'
import type { BatchItem, BatchRun } from '@/lib/api/contracts/content-batches'
import { call } from '@/lib/content-drafts/client'
import { runPool } from '@/lib/export/batch'
import { useTRPCClient } from '@/lib/trpc/react'
import { saveExportToWorkspace } from '@/lib/workspace/save-export'
import { renderTemplateVideo } from '@/lib/write/grid-render'

/** Per item: a fraction while it renders, or why it failed. */
export type RenderProgress = Record<string, number | string>

/**
 * Template videos rendered in this tab, one at a time. The server freezes each
 * concept first, so a video cannot land on one that changed since; each video
 * is uploaded and recorded on its item as soon as it is done, so closing the
 * tab loses only the one in progress. A failure is recorded too, so it is
 * still shown after a reload.
 */
export function useConceptRender({
  base,
  fileName,
  lastRender,
  onReload,
}: {
  /** The batch's API path. */
  base: string
  fileName: (item: BatchItem) => string
  /** The batch's latest render, whose failures survive a reload. */
  lastRender?: BatchRun
  onReload: () => Promise<void>
}) {
  const trpc = useTRPCClient()
  const [progress, setProgress] = React.useState<RenderProgress>(() =>
    Object.fromEntries(
      (lastRender?.items ?? []).flatMap((entry) =>
        entry.status === 'FAILED' && entry.error ? [[entry.itemId, entry.error]] : []
      )
    )
  )
  const [running, setRunning] = React.useState(false)
  const abort = React.useRef<AbortController | null>(null)

  React.useEffect(() => {
    if (!running) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [running])
  React.useEffect(() => () => abort.current?.abort(), [])

  const render = async (items: BatchItem[]) => {
    const controller = new AbortController()
    abort.current = controller
    setRunning(true)
    setProgress({})
    try {
      const run = await call<BatchRun>(`${base}/renders`, {
        body: { itemIds: items.map((item) => item.id), requestKey: `render-${crypto.randomUUID()}` },
        method: 'POST',
      })
      const report = `${base}/renders/${encodeURIComponent(run.id)}/items`
      await runPool(
        run.items,
        1,
        async (entry) => {
          const url = `${report}/${encodeURIComponent(entry.itemId)}`
          try {
            const blob = await renderTemplateVideo(entry.grid!, controller.signal, (fraction) =>
              setProgress((current) => ({ ...current, [entry.itemId]: fraction }))
            )
            const item = items.find((candidate) => candidate.id === entry.itemId)
            const name = item ? fileName(item) : 'video.mp4'
            const { assetId } = await saveExportToWorkspace({ blob, fileName: name, trpcClient: trpc })
            await call(url, { body: { assetId, fileName: name }, method: 'POST' })
            setProgress((current) => ({ ...current, [entry.itemId]: 1 }))
            await onReload()
          } catch (error) {
            if (controller.signal.aborted) return
            const message =
              error instanceof Error ? error.message : 'This video could not be rendered.'
            setProgress((current) => ({ ...current, [entry.itemId]: message }))
            // Recorded so the failure is still here after a reload; losing the record is harmless.
            await call(url, { body: { error: message }, method: 'POST' }).catch(() => undefined)
          }
        },
        controller.signal
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The videos could not be rendered.')
    } finally {
      setRunning(false)
    }
  }

  return { progress, render, running, stop: () => abort.current?.abort() }
}
