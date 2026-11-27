'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CanvasStageShell } from '@/components/canvas/CanvasStageShell'
import ClientCanvas from '@/components/canvas/ClientCanvas'
import { useBackgroundImageReady } from '@/hooks/useBackgroundImageReady'
import { applyDesignDocument, applyDesignLayout, layoutCanvasSize } from '@/lib/design/apply'
import type { DesignDocument } from '@/lib/design/document'
import { nextPaint, STAGE_ELEMENT_ID, waitForStageImages } from '@/lib/render/capture'
import { useImageStore } from '@/lib/store'
import { usePlaybackStore } from '@/lib/store/playback'
import { loadTextFonts } from '@/lib/typography/load-text-fonts'
import { loadCodeFont } from '@/lib/frames/load-code-font'

type StageRendererProps = {
  document: DesignDocument
  /** Maps `asset:` references to loadable URLs; other references load as they are. */
  sources?: Record<string, string>
  /** Timeline position to draw, in milliseconds. */
  time?: number
  /** Called once the stage shows the whole document and can be captured. */
  onReady: () => void
}

/**
 * The editor's canvas showing one document, with nothing interactive around
 * it. Every renderer (the headless server render, in-browser previews,
 * batch and multi-size export) draws through this, so a render is the
 * editor's own drawing. Mount a new one (a new `key`) for each document.
 */
export function StageRenderer({ document, sources = {}, time = 0, onReady }: StageRendererProps) {
  const [applied, setApplied] = useState(false)
  const [canvasReady, setCanvasReady] = useState(false)
  const [layoutApplied, setLayoutApplied] = useState(false)
  const backgroundConfig = useImageStore((state) => state.backgroundConfig)
  const backgroundReady = useBackgroundImageReady(backgroundConfig)
  const onReadyRef = useRef(onReady)
  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])

  useLayoutEffect(() => {
    const resolve = (ref: string) => sources[ref] ?? ref
    applyDesignDocument(document, resolve)
    usePlaybackStore.setState({ isPlaying: false, playhead: time })
    setApplied(true)
    let cancelled = false
    void layoutCanvasSize().then((dims) => {
      if (cancelled) return
      applyDesignLayout(document, resolve, dims)
      setLayoutApplied(true)
    })
    return () => {
      cancelled = true
    }
    // The document is fixed for the life of this renderer; remount for another.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!canvasReady || !backgroundReady || !layoutApplied) return
    let cancelled = false
    void (async () => {
      // Web fonts load from stylesheets added while the stage mounted.
      await loadTextFonts(useImageStore.getState().textOverlays)
      const codeMockups = useImageStore.getState().mockups.filter((mockup) => mockup.screen.code)
      if (codeMockups.length > 0) {
        await Promise.all([
          import('@/components/frames/CodeScreen'),
          ...codeMockups.map((mockup) => mockup.screen.code && loadCodeFont(mockup.screen.code)),
        ])
      }
      await window.document.fonts.ready
      // Layers placed in the layout phase paint, then their images load.
      await nextPaint()
      await waitForStageImages()
      await nextPaint()
      if (!cancelled) onReadyRef.current()
    })()
    return () => {
      cancelled = true
    }
  }, [backgroundReady, canvasReady, layoutApplied])

  return (
    <>
      <style>{`*, *::before, *::after { transition: none !important; animation: none !important; }`}</style>
      {applied ? (
        <CanvasStageShell className="shrink-0 overflow-hidden" id={STAGE_ELEMENT_ID}>
          <div className="absolute inset-0">
            <ClientCanvas embedded onReady={() => setCanvasReady(true)} />
          </div>
        </CanvasStageShell>
      ) : null}
    </>
  )
}
