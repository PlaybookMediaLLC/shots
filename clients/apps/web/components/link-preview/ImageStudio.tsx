'use client'

import { CameraIcon as Camera } from '@phosphor-icons/react/dist/ssr/Camera'
import { DownloadIcon as Download } from '@phosphor-icons/react/dist/ssr/Download'
import { EyeIcon as Eye } from '@phosphor-icons/react/dist/ssr/Eye'
import { SpinnerGapIcon as Loader2 } from '@phosphor-icons/react/dist/ssr/SpinnerGap'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { SaveToWorkspaceButton } from '@/components/workspace/SaveToWorkspaceButton'
import { Button } from '@/components/ui/button'
import type { LinkPreview } from '@/lib/api/contracts/link-preview'
import type { ScreenshotRequest } from '@/lib/api/schemas'
import { cn } from '@/lib/utils'
import { downloadBlob } from './client'
import { PANEL } from './MetadataPanels'
import { hostname } from './PlatformPreviews'
import { Label as UiLabel } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

/** The canvas is the size every platform recommends for a large card. */
const WIDTH = 1200
const HEIGHT = 630
const FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'

/** How the image is laid out: a big headline, a browser window with the page, or both side by side. */
export const imageTemplateSchema = z.enum(['headline', 'screenshot', 'split'])

const T = imageTemplateSchema.enum
const TEMPLATES = [
  { id: T.headline, name: 'Headline' },
  { id: T.screenshot, name: 'Screenshot' },
  { id: T.split, name: 'Split' },
]

type Palette = { name: string; from: string; to: string; text: string; accent: string }

const PALETTES: Palette[] = [
  { name: 'Midnight', from: '#0f172a', to: '#312e81', text: '#ffffff', accent: '#a5b4fc' },
  { name: 'Ocean', from: '#082f49', to: '#0e7490', text: '#ffffff', accent: '#67e8f9' },
  { name: 'Sunset', from: '#7c2d12', to: '#be185d', text: '#ffffff', accent: '#fdba74' },
  { name: 'Forest', from: '#052e16', to: '#15803d', text: '#ffffff', accent: '#86efac' },
  { name: 'Graphite', from: '#09090b', to: '#3f3f46', text: '#ffffff', accent: '#d4d4d8' },
  { name: 'Paper', from: '#ffffff', to: '#e2e8f0', text: '#0f172a', accent: '#475569' },
]

/** A palette from the page's theme-color, so the image matches the brand. */
function brandPalette(color: string): Palette | null {
  const hex = color.trim().match(/^#([0-9a-f]{6}|[0-9a-f]{3})$/i)?.[1]
  if (!hex) return null
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex
  const [r, g, b] = [0, 2, 4].map((index) => parseInt(full.slice(index, index + 2), 16))
  const light = 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 160
  return {
    accent: light ? '#1f2937' : '#ffffffcc',
    from: `#${full}`,
    name: 'Brand',
    text: light ? '#0f172a' : '#ffffff',
    to: light ? '#ffffff' : '#09090b',
  }
}

/** `text` broken into at most `maxLines` lines that fit `width`, the last one ellipsized. */
function wrap(context: CanvasRenderingContext2D, text: string, width: number, maxLines: number) {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (context.measureText(next).width <= width || !line) {
      line = next
      continue
    }
    lines.push(line)
    line = word
    if (lines.length === maxLines) break
  }
  if (lines.length < maxLines && line) lines.push(line)
  if (lines.length === maxLines && lines.join(' ').length < text.trim().length) {
    let last = lines[maxLines - 1]!
    while (last && context.measureText(`${last}…`).width > width) last = last.slice(0, -1)
    lines[maxLines - 1] = `${last.trimEnd()}…`
  }
  return lines.map((line) => {
    if (context.measureText(line).width <= width) return line
    const chars = [...line]
    while (chars.length && context.measureText(`${chars.join('')}…`).width > width) chars.pop()
    return `${chars.join('')}…`
  })
}

function text(
  context: CanvasRenderingContext2D,
  value: string,
  options: {
    x: number
    y: number
    width: number
    size: number
    weight: number
    color: string
    lines: number
    leading?: number
  }
): number {
  context.font = `${options.weight} ${options.size}px ${FONT}`
  context.fillStyle = options.color
  context.textBaseline = 'top'
  const leading = options.size * (options.leading ?? 1.15)
  const lines = wrap(context, value, options.width, options.lines)
  lines.forEach((line, index) => context.fillText(line, options.x, options.y + index * leading))
  return options.y + lines.length * leading
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  context.beginPath()
  context.roundRect(x, y, width, height, radius)
}

/** A browser window holding the page screenshot, cropped to fill it. */
function browser(
  context: CanvasRenderingContext2D,
  frame: { x: number; y: number; width: number; height: number },
  shot: HTMLImageElement | null,
  host: string
) {
  const bar = 44
  context.save()
  context.shadowColor = 'rgba(0,0,0,0.45)'
  context.shadowBlur = 60
  context.shadowOffsetY = 24
  roundedRect(context, frame.x, frame.y, frame.width, frame.height, 18)
  context.fillStyle = '#18181b'
  context.fill()
  context.restore()
  context.save()
  roundedRect(context, frame.x, frame.y, frame.width, frame.height, 18)
  context.clip()
  context.fillStyle = '#27272a'
  context.fillRect(frame.x, frame.y, frame.width, bar)
  ;['#ff5f57', '#febc2e', '#28c840'].forEach((color, index) => {
    context.beginPath()
    context.arc(frame.x + 24 + index * 20, frame.y + bar / 2, 6, 0, Math.PI * 2)
    context.fillStyle = color
    context.fill()
  })
  roundedRect(context, frame.x + frame.width / 2 - 160, frame.y + 10, 320, bar - 20, 8)
  context.fillStyle = '#3f3f46'
  context.fill()
  context.font = `500 15px ${FONT}`
  context.fillStyle = '#d4d4d8'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText(host, frame.x + frame.width / 2, frame.y + bar / 2 + 1)
  context.textAlign = 'left'
  const area = { height: frame.height - bar, width: frame.width, x: frame.x, y: frame.y + bar }
  if (shot) {
    const scale = Math.max(area.width / shot.naturalWidth, area.height / shot.naturalHeight)
    context.drawImage(shot, area.x, area.y, shot.naturalWidth * scale, shot.naturalHeight * scale)
  } else {
    context.fillStyle = '#3f3f46'
    ;[0.55, 0.8, 0.7, 0.45].forEach((share, index) =>
      context.fillRect(area.x + 40, area.y + 40 + index * 44, (area.width - 80) * share, 18)
    )
  }
  context.restore()
}

type Draft = {
  template: z.infer<typeof imageTemplateSchema>
  palette: Palette
  title: string
  subtitle: string
  site: string
  host: string
  shot: HTMLImageElement | null
}

function draw(context: CanvasRenderingContext2D, draft: Draft) {
  const { palette } = draft
  const background = context.createLinearGradient(0, 0, WIDTH, HEIGHT)
  background.addColorStop(0, palette.from)
  background.addColorStop(1, palette.to)
  context.fillStyle = background
  context.fillRect(0, 0, WIDTH, HEIGHT)
  const glow = context.createRadialGradient(160, 80, 0, 160, 80, 700)
  glow.addColorStop(0, 'rgba(255,255,255,0.16)')
  glow.addColorStop(1, 'rgba(255,255,255,0)')
  context.fillStyle = glow
  context.fillRect(0, 0, WIDTH, HEIGHT)

  if (draft.template === T.headline) {
    text(context, draft.site.toUpperCase(), {
      color: palette.accent,
      lines: 1,
      size: 26,
      weight: 600,
      width: 1040,
      x: 80,
      y: 80,
    })
    const bottom = text(context, draft.title, {
      color: palette.text,
      leading: 1.08,
      lines: 3,
      size: 76,
      weight: 800,
      width: 1040,
      x: 80,
      y: 140,
    })
    text(context, draft.subtitle, {
      color: palette.text,
      lines: 2,
      size: 32,
      weight: 400,
      width: 980,
      x: 80,
      y: bottom + 28,
    })
    text(context, draft.host, {
      color: palette.accent,
      lines: 1,
      size: 26,
      weight: 500,
      width: 1040,
      x: 80,
      y: HEIGHT - 80,
    })
    return
  }
  if (draft.template === T.screenshot) {
    context.textAlign = 'left'
    text(context, draft.title, {
      color: palette.text,
      leading: 1.08,
      lines: 2,
      size: 54,
      weight: 800,
      width: 1040,
      x: 80,
      y: 56,
    })
    browser(context, { height: 440, width: 1040, x: 80, y: 236 }, draft.shot, draft.host)
    return
  }
  text(context, draft.site.toUpperCase(), {
    color: palette.accent,
    lines: 1,
    size: 22,
    weight: 600,
    width: 520,
    x: 64,
    y: 96,
  })
  const bottom = text(context, draft.title, {
    color: palette.text,
    leading: 1.08,
    lines: 4,
    size: 58,
    weight: 800,
    width: 520,
    x: 64,
    y: 140,
  })
  text(context, draft.subtitle, {
    color: palette.text,
    lines: 3,
    size: 26,
    weight: 400,
    width: 500,
    x: 64,
    y: bottom + 24,
  })
  browser(context, { height: 470, width: 640, x: 640, y: 80 }, draft.shot, draft.host)
}

const INPUT =
  'w-full rounded-lg bg-white/[0.03] px-3 py-2 text-sm text-foreground ring-1 ring-white/[0.08] outline-none placeholder:text-muted-foreground focus:ring-white/25'

/**
 * Make a 1200 × 630 preview image from the page's own title, description, and
 * a live screenshot, then download it, save it to the workspace, or try it on
 * every platform's card.
 */
export function ImageStudio({
  onUse,
  preview,
  url,
}: {
  /** Show the image in every preview; receives a blob: URL. */
  onUse: (imageUrl: string) => void
  preview: LinkPreview
  url: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const brand = preview.themeColor ? brandPalette(preview.themeColor) : null
  const palettes = brand ? [brand, ...PALETTES] : PALETTES
  const [template, setTemplate] = useState(T.headline as Draft['template'])
  const [palette, setPalette] = useState(palettes[0]!)
  const [title, setTitle] = useState(preview.ogTitle || preview.title || hostname(url))
  const [subtitle, setSubtitle] = useState(preview.ogDescription || preview.description || '')
  const [site, setSite] = useState(preview.ogSiteName || hostname(url))
  const [shot, setShot] = useState<HTMLImageElement | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [captureError, setCaptureError] = useState('')
  const [exportError, setExportError] = useState('')
  const generatedUrl = useRef<string | null>(null)
  useEffect(() => () => {
    if (generatedUrl.current) URL.revokeObjectURL(generatedUrl.current)
  }, [])

  useEffect(() => {
    const context = canvas.current?.getContext('2d')
    if (!context) return
    let cancelled = false
    // Canvas text needs the web font loaded, or the first draw uses a fallback.
    document.fonts.ready.then(() => {
      if (!cancelled)
        draw(context, { host: hostname(url), palette, shot, site, subtitle, template, title })
    })
    return () => {
      cancelled = true
    }
  }, [palette, shot, site, subtitle, template, title, url])

  async function capture() {
    setCapturing(true)
    setCaptureError('')
    try {
      const request: ScreenshotRequest = {
        colorScheme: 'dark',
        deviceType: 'desktop',
        forceRefresh: false,
        url: preview.url,
      }
      const response = await fetch('/api/screenshot', {
        body: JSON.stringify(request),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      const body = await response.json().catch(() => null)
      if (!response.ok || typeof body?.screenshot !== 'string') {
        throw new Error(body?.message ?? 'The page could not be captured.')
      }
      const image = new Image()
      image.src = `data:image/png;base64,${body.screenshot}`
      await image.decode()
      setShot(image)
      if (template === T.headline) setTemplate(T.split)
    } catch (caught) {
      setCaptureError(caught instanceof Error ? caught.message : 'The page could not be captured.')
    } finally {
      setCapturing(false)
    }
  }

  async function toBlob(): Promise<Blob> {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) throw new Error('The image could not be made.')
    await document.fonts.ready
    draw(context, { host: hostname(url), palette, shot, site, subtitle, template, title })
    for (const quality of [0.92, 0.8, 0.65, 0.45]) {
      const blob = await new Promise<Blob | null>((resolve) =>
        element.toBlob(resolve, 'image/jpeg', quality)
      )
      if (blob && blob.size <= 600 * 1024) return blob
    }
    throw new Error('The image is over 600 KB. Try a simpler layout or remove the screenshot.')
  }

  async function exportImage(download: boolean) {
    setExportError('')
    try {
      const blob = await toBlob()
      if (download) downloadBlob(`${hostname(url)}-${template}-preview.jpg`, blob)
      else {
        if (generatedUrl.current) URL.revokeObjectURL(generatedUrl.current)
        generatedUrl.current = URL.createObjectURL(blob)
        onUse(generatedUrl.current)
      }
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'The image could not be made.')
    }
  }

  return (
    <section className={cn(PANEL, 'space-y-5 p-5')}>
      <div>
        <h3 className="text-ui-lg font-medium text-foreground">Create a preview image</h3>
        <p className="text-xs text-muted-foreground">
          A 1200 × 630 JPEG under 600 KB from the page&apos;s own copy, in your brand color or a preset.
        </p>
      </div>
      <canvas
        ref={canvas}
        width={WIDTH}
        height={HEIGHT}
        className="h-auto w-full rounded-xl ring-1 ring-white/10"
        aria-label="Generated preview image"
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <UiLabel className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">Headline</span>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className={INPUT}
            />
          </UiLabel>
          <UiLabel className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">Supporting line</span>
            <Textarea
              value={subtitle}
              onChange={(event) => setSubtitle(event.target.value)}
              rows={2}
              className={cn(INPUT, 'resize-none')}
            />
          </UiLabel>
          <UiLabel className="block space-y-1.5">
            <span className="text-xs text-muted-foreground">Label</span>
            <Input
              value={site}
              onChange={(event) => setSite(event.target.value)}
              className={INPUT}
            />
          </UiLabel>
        </div>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Layout</p>
            <div className="flex flex-wrap gap-1.5">
              {TEMPLATES.map((item) => (
                <Button variant="custom" size={null}
                  key={item.id}
                  type="button"
                  onClick={() => setTemplate(item.id)}
                  className={cn(
                    'rounded-full px-3 py-1 text-xs transition-colors',
                    template === item.id
                      ? 'bg-white text-black'
                      : 'bg-white/[0.05] text-muted-foreground hover:text-foreground'
                  )}
                >
                  {item.name}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Colors</p>
            <div className="flex flex-wrap gap-2">
              {palettes.map((item) => (
                <Button variant="custom" size={null}
                  key={item.name}
                  type="button"
                  title={item.name}
                  aria-label={`${item.name} colors`}
                  aria-pressed={palette.name === item.name}
                  onClick={() => setPalette(item)}
                  className={cn(
                    'size-8 rounded-full ring-2 ring-offset-2 ring-offset-[#111111] transition',
                    palette.name === item.name
                      ? 'ring-white'
                      : 'ring-transparent hover:ring-white/30'
                  )}
                  style={{ background: `linear-gradient(135deg, ${item.from}, ${item.to})` }}
                />
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={capture}
              disabled={capturing}
            >
              {capturing ? <Loader2 className="animate-spin" /> : <Camera />}
              {shot ? 'Capture the page again' : 'Add a screenshot of the page'}
            </Button>
            {captureError && <p className="text-xs text-red-400">{captureError}</p>}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 border-t border-white/[0.07] pt-4">
        <Button
          type="button"
          size="sm"
          onClick={() => exportImage(false)}
        >
          <Eye />
          Preview on every platform
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => exportImage(true)}
        >
          <Download />
          Download JPEG
        </Button>
        <SaveToWorkspaceButton createExport={toBlob} fileName={`${hostname(url)}-${template}-preview.jpg`} />
        {exportError && <p role="alert" className="w-full text-sm text-red-400">{exportError}</p>}
      </div>
    </section>
  )
}
