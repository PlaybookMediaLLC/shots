'use client'

import * as React from 'react'
import { CopySimpleIcon } from '@phosphor-icons/react/dist/ssr/CopySimple'
import { GOOGLE_FONTS_URL } from '@/components/code-image/code-themes'
import { Button } from '@/components/ui/button'
import { activeFile, readCodeDocument } from '@/lib/code-studio/document'
import { slideSize } from '@/lib/code-studio/layout'
import { CodeScene } from './CodeScene'

/**
 * A shared code project as real text (RFC 053): the first slide, scaled to
 * the frame, with the code selectable and one click to copy it.
 */
export function CodeEmbed({ code, title }: { code: unknown; title: string }) {
  const document = React.useMemo(() => readCodeDocument(code), [code])
  const ref = React.useRef<HTMLDivElement>(null)
  const [width, setWidth] = React.useState(0)
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  if (!document)
    return <p className="p-4 text-sm text-neutral-400">This code embed cannot be shown.</p>
  const size = slideSize(document, 0)
  const scale = width ? Math.min(1, width / size.width) : 0
  const text = document.slides[0]!.panes.map((pane) => {
    const file = activeFile(pane)
    return file.tape ?? file.code
  }).join('\n\n')
  return (
    <div ref={ref} className="relative w-full" aria-label={title}>
      <link rel="stylesheet" href={GOOGLE_FONTS_URL} />
      <div style={{ width: size.width * scale, height: size.height * scale, margin: '0 auto' }}>
        {scale ? (
          <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
            <CodeScene document={document} slideIndex={0} />
          </div>
        ) : null}
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="absolute top-3 right-3"
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1_500)
          })
        }
      >
        <CopySimpleIcon /> {copied ? 'Copied' : 'Copy code'}
      </Button>
    </div>
  )
}
