'use client'

import * as React from 'react'
import { toast } from 'sonner'
import type { BatchItem, BatchRun } from '@/lib/api/contracts/content-batches'
import { call } from '@/lib/content-drafts/client'
import { assetContentUrl } from '@/lib/editor/services'
import { runPool } from '@/lib/export/batch'
import { zipFiles } from '@/lib/export/zip'
import { downloadBlob } from '@/lib/image-tools/download'
import { useTRPCClient } from '@/lib/trpc/react'
import { saveExportToWorkspace } from '@/lib/workspace/save-export'
import { renderTemplateVideo } from '@/lib/write/grid-render'

/** A rendered video's file name: its template and its place in the batch. */
export function videoFileName(item: BatchItem) {
  const prefix = { grid: 'grid-video', single: 'fade-in-video', ugc: 'ugc-video' }[
    item.grid?.kind ?? 'grid'
  ]
  return `${prefix}-${item.position + 1}.mp4`
}

/** The batch's one renderer, shared by every template creator on the page. */
export type ConceptRenderer = ReturnType<typeof useConceptRender>

/**
 * Template videos rendered in this tab, one at a time, for the whole batch: the
 * server keeps one render per batch, so every creator shares this one. The
 * server freezes each concept first, so a video cannot land on one that changed
 * since; each video is uploaded and recorded on its item as soon as it is done,
 * so closing the tab loses only the one in progress. A failure is recorded too,
 * so it is still shown after a reload.
 */
export function useConceptRender({
  base,
  lastRender,
  onReload,
  settled,
}: {
  /** The batch's API path. */
  base: string
  /** The batch's latest render, whose failures survive a reload. */
  lastRender?: BatchRun
  onReload: () => Promise<void>
  /** Saves still on their way: a render freezes concepts only after they land. */
  settled: () => Promise<unknown>
}) {
  const trpc = useTRPCClient()
  const [progress, setProgress] = React.useState<Record<string, number | string>>(() =>
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
    if (running) return
    const controller = new AbortController()
    abort.current = controller
    setRunning(true)
    setProgress({})
    try {
      await settled()
      const run = await call<BatchRun>(`${base}/renders`, {
        body: {
          itemIds: items.map((item) => item.id),
          requestKey: `render-${crypto.randomUUID()}`,
        },
        method: 'POST',
      })
      const report = `${base}/renders/${encodeURIComponent(run.id)}/items`
      await runPool(
        run.items,
        1,
        async (entry) => {
          const url = `${report}/${encodeURIComponent(entry.itemId)}`
          try {
            // Whole percents only: a long clip would otherwise redraw the page every frame.
            const blob = await renderTemplateVideo(entry.grid!, controller.signal, (fraction) =>
              setProgress((current) => {
                const shown = current[entry.itemId]
                return typeof shown === 'number' &&
                  Math.floor(shown * 100) === Math.floor(fraction * 100)
                  ? current
                  : { ...current, [entry.itemId]: fraction }
              })
            )
            const item = items.find((candidate) => candidate.id === entry.itemId)
            const name = item ? videoFileName(item) : 'video.mp4'
            const { assetId } = await saveExportToWorkspace({
              blob,
              fileName: name,
              trpcClient: trpc,
            })
            await call(url, { body: { assetId, fileName: name }, method: 'POST' })
            setProgress((current) => ({ ...current, [entry.itemId]: 1 }))
            await onReload()
          } catch (error) {
            if (controller.signal.aborted) {
              setProgress(({ [entry.itemId]: _stopped, ...rest }) => rest)
              return
            }
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

  const fetchVideo = async (item: BatchItem) => {
    const assetId = item.media.find((entry) => entry.assetId)?.assetId
    if (!assetId) throw new Error('This video is not rendered yet.')
    const response = await fetch(assetContentUrl(assetId))
    if (!response.ok) throw new Error('A video could not be downloaded.')
    return response.blob()
  }
  /** One finished video as its file. */
  const download = (item: BatchItem) =>
    fetchVideo(item).then(
      (blob) => downloadBlob(blob, videoFileName(item)),
      () => toast.error('The video could not be downloaded.')
    )
  /** Finished videos: one as its file, several as a ZIP. */
  const downloadAll = async (items: BatchItem[], zipName: string) => {
    try {
      if (items.length === 1) {
        downloadBlob(await fetchVideo(items[0]!), videoFileName(items[0]!))
        return
      }
      const entries = await Promise.all(
        items.map(async (item) => ({ data: await fetchVideo(item), path: videoFileName(item) }))
      )
      downloadBlob(await zipFiles(entries), zipName)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The videos could not be downloaded.')
    }
  }

  return {
    download,
    downloadAll,
    progress,
    render,
    running,
    stop: () => abort.current?.abort(),
  }
}
