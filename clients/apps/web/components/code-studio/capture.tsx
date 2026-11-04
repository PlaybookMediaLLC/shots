'use client'

import * as React from 'react'
import { flushSync } from 'react-dom'
import {
  createContext,
  destroyContext,
  domToBlob,
  domToCanvas,
  type Context,
} from 'modern-screenshot'
import { allFiles, type CodeDocument } from '@/lib/code-studio/document'
import { highlightLines } from '@/lib/code-studio/highlight'
import { AnimatedScene, type AnimatedSceneProps } from './AnimatedScene'
import { CodeScene, type CodeSceneProps } from './CodeScene'

/** Highlight every file first, so each captured frame renders synchronously. */
export async function prehighlight(project: CodeDocument): Promise<void> {
  await Promise.all(
    allFiles(project).flatMap((file) => [
      highlightLines(file.code, file.lang),
      ...(file.base !== undefined ? [highlightLines(file.base, file.lang)] : []),
    ])
  )
}

const nextPaint = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )

/** One still to draw off screen. */
export type SceneFrame = Omit<CodeSceneProps, 'editing'>

type Drawing = { kind: 'still'; props: SceneFrame } | { kind: 'video'; props: AnimatedSceneProps }

/**
 * An off-screen scene for exports: draw a still or a video frame, wait for it
 * to paint, then capture it. Exports never include the editor's caret,
 * selection or overlays.
 */
export function useSceneCapture() {
  const ref = React.useRef<HTMLDivElement>(null)
  const [drawing, setDrawing] = React.useState<Drawing | null>(null)
  const draw = React.useCallback(async (next: Drawing): Promise<HTMLDivElement> => {
    flushSync(() => setDrawing(next))
    await nextPaint()
    await window.document.fonts.ready
    if (!ref.current) throw new Error('The export could not be drawn.')
    return ref.current
  }, [])
  const png = React.useCallback(
    async (props: SceneFrame, scale: number): Promise<Blob> => {
      await prehighlight(props.document)
      const node = await draw({ kind: 'still', props })
      const blob = await domToBlob(node, { scale, type: 'image/png' })
      if (!blob) throw new Error('The export produced no image.')
      return blob
    },
    [draw]
  )
  /**
   * Draw video frames one by one. The capture context is created once and
   * reused, so fonts and images are embedded once for the whole video.
   */
  const frames = React.useCallback(
    async (
      props: Omit<AnimatedSceneProps, 'time'>,
      times: Iterable<number>,
      scale: number,
      onFrame: (canvas: HTMLCanvasElement, index: number) => Promise<void>
    ) => {
      await prehighlight(props.document)
      let context: Context<HTMLDivElement> | null = null
      try {
        let index = 0
        for (const time of times) {
          const node = await draw({ kind: 'video', props: { ...props, time } })
          context ??= await createContext(node, { scale, autoDestruct: false })
          await onFrame(await domToCanvas(context), index++)
        }
      } finally {
        if (context) destroyContext(context)
      }
    },
    [draw]
  )
  const done = React.useCallback(() => setDrawing(null), [])
  const host = drawing ? (
    <div aria-hidden style={{ position: 'fixed', left: -100_000, top: 0, pointerEvents: 'none' }}>
      {drawing.kind === 'still' ? (
        <CodeScene ref={ref} {...drawing.props} />
      ) : (
        <AnimatedScene ref={ref} {...drawing.props} />
      )}
    </div>
  ) : null
  return { host, png, frames, done }
}

/** What {@link useSceneCapture} returns. */
export type SceneCapture = ReturnType<typeof useSceneCapture>
