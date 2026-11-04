'use client'

import { useEffect, useRef, useState } from 'react'
import JSZip from 'jszip'
import { trackEvent } from '@/lib/analytics'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { saveExportToWorkspace } from '@/lib/workspace/save-export'
import { renderStoryOutput, downloadBlob } from '@/lib/creative-sets/delivery'
import { outputDimensions, storyForOutput } from '@/lib/creative-sets/document'
import type { CreativeSetSession } from '@/lib/creative-sets/session'

type Rendered = Awaited<ReturnType<typeof renderStoryOutput>>
type Item = {
  outputId: string
  name: string
  result?: Rendered
  url?: string
  error?: string
  asset?: string
}

export function StorySetExport({
  session,
  canSave,
  onClose,
  onFix,
}: {
  session: CreativeSetSession
  canSave: boolean
  onClose: () => void
  onFix: (id: string) => void
}) {
  const [snapshot] = useState(() => ({
    document: structuredClone(session.snapshot().document),
    revision: session.snapshot().revision,
  }))
  const [items, setItems] = useState<Item[]>(
    snapshot.document.outputs.map((output) => ({
      outputId: output.id,
      name: `${storyForOutput(snapshot.document, output).headline} · ${outputDimensions(output).name}`,
    }))
  )
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [saved, setSaved] = useState(false)
  const urls = useRef<string[]>([])
  useEffect(() => {
    const abort = new AbortController()
    void (async () => {
      try {
        if (canSave)
          await session.client.creativeSet.createVersion.mutate({
            creativeSetId: session.record.id,
            name: `Delivery revision ${snapshot.revision}`,
            baseRevision: snapshot.revision,
          })
      } catch (error) {
        if (!abort.signal.aborted)
          setItems((items) =>
            items.map((item) => ({
              ...item,
              error:
                error instanceof Error ? error.message : 'Could not pin the delivery revision.',
            }))
          )
        return
      }
      for (const output of snapshot.document.outputs) {
        try {
          const result = await renderStoryOutput(
            session.client,
            snapshot.document,
            output,
            session.record.name,
            snapshot.revision,
            abort.signal
          )
          if (abort.signal.aborted) return
          const url = URL.createObjectURL(result.blob)
          urls.current.push(url)
          setItems((items) =>
            items.map((item) => (item.outputId === output.id ? { ...item, result, url } : item))
          )
        } catch (error) {
          if (abort.signal.aborted) return
          trackEvent('story_set_export_failed', { format: output.format, reason: 'render' })
          setItems((items) =>
            items.map((item) =>
              item.outputId === output.id
                ? { ...item, error: error instanceof Error ? error.message : 'Export failed.' }
                : item
            )
          )
        }
      }
    })()
    const currentUrls = urls.current
    return () => {
      abort.abort()
      currentUrls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [session, snapshot, canSave])
  const ready = items.every((item) => item.result)
  async function zip() {
    setBusy(true)
    setError(null)
    try {
      const archive = new JSZip()
      for (const item of items)
        if (item.result) archive.file(item.result.manifest.fileName, item.result.blob)
      archive.file(
        'manifest.json',
        JSON.stringify(
          {
            setId: session.record.id,
            revision: snapshot.revision,
            outputs: items.map((item) => item.result!.manifest),
          },
          null,
          2
        )
      )
      downloadBlob(
        await archive.generateAsync({ type: 'blob' }),
        `story-set-r${snapshot.revision}.zip`
      )
    } catch (error) {
      setError(error instanceof Error ? error.message : 'ZIP creation failed.')
    } finally {
      setBusy(false)
    }
  }
  async function saveAssets() {
    setBusy(true)
    setError(null)
    const delivered = []
    try {
      for (const item of items) {
        if (!item.result) continue
        let asset = item.asset
        if (!asset) {
          const saved = await saveExportToWorkspace({
            blob: item.result.blob,
            fileName: item.result.manifest.fileName,
            trpcClient: session.client,
          })
          asset = `asset:${saved.assetId}`
          item.asset = asset
          setItems([...items])
        }
        delivered.push({ ...item.result.manifest, asset })
      }
      const document = structuredClone(session.snapshot().document)
      const known = new Set(document.deliveries.map((delivery) => delivery.id))
      document.deliveries.push(...delivered.filter((delivery) => !known.has(delivery.id)))
      session.commit(document, false)
      if (!(await session.save()))
        throw new Error(
          'Files uploaded. Save the set successfully to retain their delivery record; retry will reuse these files.'
        )
      await session.client.creativeSet.createVersion.mutate({
        creativeSetId: session.record.id,
        name: `Delivered revision ${snapshot.revision}`,
      })
      setSaved(true)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Saving assets failed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="max-h-[90vh] gap-5 overflow-auto sm:max-w-5xl">
        <DialogTitle>Deliver Story Set</DialogTitle>
        <DialogDescription>
          {items.length} formats, checked at their final size. Select a preview to inspect the exact
          PNG. This delivery uses revision {snapshot.revision}.
        </DialogDescription>
        <div className="grid gap-5 md:grid-cols-3">
          {items.map((item) => (
            <article
              key={item.outputId}
              className="min-w-0 overflow-hidden rounded-xl border bg-foreground/[0.02]"
            >
              <h3 className="truncate px-4 pt-4 text-ui-lg font-medium" title={item.name}>
                {
                  outputDimensions(
                    snapshot.document.outputs.find((output) => output.id === item.outputId)!
                  ).name
                }
              </h3>
              {item.url ? (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Inspect ${item.name} at actual size`}
                  className="flex h-64 items-center justify-center p-4"
                >
                  <img
                    src={item.url}
                    alt={item.name}
                    className="max-h-full w-full object-contain"
                  />
                </a>
              ) : (
                <div className="grid h-64 place-items-center px-4 text-sm text-muted-foreground">
                  {item.error ? 'Needs attention' : 'Checking and rendering…'}
                </div>
              )}
              {item.result ? (
                <>
                  <div className="space-y-1 border-t px-4 pt-3">
                    <p className="text-xs text-muted-foreground">
                      PNG · {item.result.width} × {item.result.height}
                    </p>
                    <p
                      className="truncate text-xs text-muted-foreground"
                      title={item.result.manifest.fileName}
                    >
                      {item.result.manifest.fileName}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    className="m-2"
                    size="sm"
                    onClick={() => downloadBlob(item.result!.blob, item.result!.manifest.fileName)}
                  >
                    Download PNG
                  </Button>
                </>
              ) : null}
              {item.error ? (
                <>
                  <p role="alert" className="px-4 text-sm text-destructive">
                    {item.error}
                  </p>
                  <Button
                    variant="outline"
                    className="m-4"
                    onClick={() => {
                      onClose()
                      onFix(item.outputId)
                    }}
                  >
                    Fix this format
                  </Button>
                </>
              ) : null}
            </article>
          ))}
        </div>
        {error ? (
          <p role="alert" className="px-4 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p role="status">
            {items.length} new files saved to workspace assets. Earlier delivered assets are
            unchanged.
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-3 border-t pt-5">
          <Button
            variant="outline"
            hidden={!canSave}
            onClick={() => void saveAssets()}
            disabled={!ready || busy || saved}
          >
            {saved ? 'Saved to assets' : 'Save to workspace assets'}
          </Button>
          <Button onClick={() => void zip()} disabled={!ready || busy}>
            Download ZIP
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
