'use client'

import * as React from 'react'
import { domToBlob } from 'modern-screenshot'
import { GOOGLE_FONTS_URL } from '@/components/code-image/code-themes'
import type { CodeDocument } from '@/lib/code-studio/document'
import { prehighlight } from './capture'
import { CodeScene } from './CodeScene'

declare global {
  interface Window {
    __codeReady?: boolean
    __exportCode?: () => Promise<{ base64: string; height: number; width: number }>
  }
}

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

/**
 * One slide of a code project for the headless renderer (RFC 053). Once the
 * grammar and fonts load it sets `window.__codeReady`, and
 * `window.__exportCode` captures it exactly as the studio's PNG export does.
 */
export function CodeRender({
  document,
  slide,
  scale,
  logoUrl,
}: {
  document: CodeDocument
  slide: number
  scale: number
  logoUrl?: string
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [ready, setReady] = React.useState(false)
  React.useEffect(() => {
    void prehighlight(document).then(() => setReady(true))
  }, [document])
  React.useEffect(() => {
    if (!ready) return
    let live = true
    void window.document.fonts.ready.then(() => {
      if (!live) return
      window.__exportCode = async () => {
        const blob = await domToBlob(ref.current!, { scale, type: 'image/png' })
        if (!blob) throw new Error('The code render produced no image.')
        const { height, width } = ref.current!.getBoundingClientRect()
        return {
          base64: await base64(blob),
          height: Math.round(height * scale),
          width: Math.round(width * scale),
        }
      }
      window.__codeReady = true
    })
    return () => {
      live = false
    }
  }, [ready, scale])
  return (
    <main style={{ display: 'inline-block' }}>
      <link rel="stylesheet" href={GOOGLE_FONTS_URL} />
      <CodeScene ref={ref} document={document} slideIndex={slide} logoUrl={logoUrl} />
    </main>
  )
}
