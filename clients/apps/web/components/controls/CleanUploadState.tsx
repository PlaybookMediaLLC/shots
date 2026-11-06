'use client'

import * as React from 'react'
import { useDropzone } from 'react-dropzone'
import { CameraIcon as Camera01Icon } from '@phosphor-icons/react/dist/ssr/Camera'
import { CommandIcon as CommandIcon } from '@phosphor-icons/react/dist/ssr/Command'
import { GlobeIcon as Globe02Icon } from '@phosphor-icons/react/dist/ssr/Globe'
import { SpinnerGapIcon as Loading03Icon } from '@phosphor-icons/react/dist/ssr/SpinnerGap'
import { MoonIcon as Moon } from '@phosphor-icons/react/dist/ssr/Moon'
import { SunIcon as Sun } from '@phosphor-icons/react/dist/ssr/Sun'
import { MAX_IMAGE_SIZE } from '@/lib/constants'
import { useImageStore } from '@/lib/store'
import { importImages } from '@/lib/editor/import-images'
import { browserDisplayUrl } from '@/lib/browser-url'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { getBackgroundCSS } from '@/lib/constants/backgrounds'
import { useBackgroundImageReady } from '@/hooks/useBackgroundImageReady'
import { Label } from '@/components/ui/label'
import { requestTextEdit } from '@/lib/editor/pending-text-edit'

const TRANSITION_DURATION = 400 // ms
type ColorScheme = 'light' | 'dark'

function extractImageUrl(style: React.CSSProperties): string | null {
  const bg = style.backgroundImage
  if (!bg || typeof bg !== 'string') return null
  const match = bg.match(/url\(([^)]+)\)/)
  if (!match) return null
  return match[1].replace(/['"]/g, '')
}

function preloadImage(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new window.Image()
    img.onload = () => resolve(url)
    img.onerror = () => reject(new Error(`Failed to load: ${url}`))
    img.src = url
  })
}

export function CleanUploadState() {
  const [isDragActive, setIsDragActive] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [screenshotUrl, setScreenshotUrl] = React.useState('')
  const [colorScheme, setColorScheme] = React.useState<ColorScheme>('light')
  const [isCapturing, setIsCapturing] = React.useState(false)

  const { setBrowserUrl, backgroundConfig, addTextOverlay } = useImageStore()
  const containerRef = React.useRef<HTMLDivElement>(null)

  // Crossfade state
  const backgroundStyle = React.useMemo(
    () => getBackgroundCSS(backgroundConfig),
    [backgroundConfig]
  )
  const [activeLayer, setActiveLayer] = React.useState<'a' | 'b'>('a')
  const [layerAStyle, setLayerAStyle] = React.useState<React.CSSProperties>(backgroundStyle)
  const [layerBStyle, setLayerBStyle] = React.useState<React.CSSProperties>(backgroundStyle)
  const [showTransition, setShowTransition] = React.useState(false)
  const prevConfigRef = React.useRef(backgroundConfig)
  const isFirstRender = React.useRef(true)
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout>>(undefined)
  const backgroundReady = useBackgroundImageReady(backgroundConfig)
  const placeholderStyle = getBackgroundCSS(backgroundConfig, 32)

  React.useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      setLayerAStyle(backgroundStyle)
      setLayerBStyle(backgroundStyle)
      return
    }

    const prev = prevConfigRef.current
    const changed = prev.type !== backgroundConfig.type || prev.value !== backgroundConfig.value

    if (!changed) {
      if (activeLayer === 'a') setLayerAStyle(backgroundStyle)
      else setLayerBStyle(backgroundStyle)
      return
    }

    prevConfigRef.current = backgroundConfig
    let cancelled = false

    const applyNewBackground = (style: React.CSSProperties) => {
      if (cancelled) return
      if (activeLayer === 'a') {
        setLayerBStyle(style)
        setShowTransition(true)
        requestAnimationFrame(() => {
          if (!cancelled) setActiveLayer('b')
        })
      } else {
        setLayerAStyle(style)
        setShowTransition(true)
        requestAnimationFrame(() => {
          if (!cancelled) setActiveLayer('a')
        })
      }
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      timeoutRef.current = setTimeout(() => setShowTransition(false), TRANSITION_DURATION + 50)
    }

    if (backgroundConfig.type === 'image') {
      const url = extractImageUrl(backgroundStyle)
      if (url) {
        preloadImage(url)
          .then((loadedUrl) => {
            applyNewBackground({ ...backgroundStyle, backgroundImage: `url(${loadedUrl})` })
          })
          .catch(() => applyNewBackground(backgroundStyle))
        return () => {
          cancelled = true
          if (timeoutRef.current) clearTimeout(timeoutRef.current)
        }
      }
    }

    applyNewBackground(backgroundStyle)
    return () => {
      cancelled = true
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [backgroundConfig, backgroundStyle, activeLayer])

  const handleFiles = React.useCallback(async (files: File[]) => {
    try {
      const result = await importImages(files)
      setError(result.imported === 0 ? (result.rejected[0]?.reason ?? null) : null)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'The image could not be imported.')
    }
  }, [])

  const onFileInputChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      handleFiles(Array.from(event.currentTarget.files ?? []))
      event.currentTarget.value = ''
    },
    [handleFiles]
  )

  const { getRootProps, isDragActive: dropzoneActive } = useDropzone({
    onDrop: handleFiles,
    accept: {
      'image/jpeg': ['.jpg', '.jpeg'],
      'image/png': ['.png'],
      'image/webp': ['.webp'],
    },
    maxSize: MAX_IMAGE_SIZE,
    multiple: true,
    noClick: true,
    onDragEnter: () => {
      setIsDragActive(true)
      setError(null)
    },
    onDragLeave: () => setIsDragActive(false),
    onDropRejected: (rejectedFiles) => {
      if (rejectedFiles.length > 0) {
        const rejection = rejectedFiles[0]
        if (rejection.errors.some((e) => e.code === 'file-too-large')) {
          setError(`File size too large. Maximum size is ${MAX_IMAGE_SIZE / 1024 / 1024}MB`)
        } else if (rejection.errors.some((e) => e.code === 'file-invalid-type')) {
          setError('File type not supported. Please use: PNG, JPG, WEBP')
        } else {
          setError('Failed to upload file. Please try again.')
        }
      }
    },
  })

  React.useEffect(() => {
    containerRef.current?.focus()
  }, [])

  const handleCaptureScreenshot = async () => {
    if (!screenshotUrl.trim()) {
      setError('Please enter a URL')
      return
    }
    let finalUrl = screenshotUrl.trim()
    if (!finalUrl.match(/^https?:\/\//i)) {
      finalUrl = `https://${finalUrl}`
    }
    setIsCapturing(true)
    setError(null)
    try {
      const response = await fetch('/api/screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: finalUrl, deviceType: 'desktop', colorScheme }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to capture screenshot')
      let base64Data = data.screenshot.trim()
      if (base64Data.includes(',')) base64Data = base64Data.split(',')[1]
      base64Data = base64Data.replace(/\s/g, '')
      const byteCharacters = atob(base64Data)
      const byteNumbers = new Array(byteCharacters.length)
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i)
      }
      const byteArray = new Uint8Array(byteNumbers)
      const blob = new Blob([byteArray], { type: 'image/png' })
      const file = new File([blob], `${new URL(finalUrl).hostname}.png`, { type: 'image/png' })
      const result = await importImages([file])
      if (!result.imported) throw new Error(result.rejected[0]?.reason ?? 'The screenshot could not be imported.')
      // Show the captured page's address in the browser frame, not the default URL.
      setBrowserUrl(browserDisplayUrl(finalUrl))
      setScreenshotUrl('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to capture screenshot')
    } finally {
      setIsCapturing(false)
    }
  }

  const active = isDragActive || dropzoneActive

  return (
    <div
      ref={containerRef}
      {...getRootProps()}
      // This dropzone imports its own drops; the global one must not import them again.
      data-local-dropzone="true"
      tabIndex={0}
      className="relative w-full h-full flex items-center justify-center outline-none overflow-hidden"
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          ...layerAStyle,
          transition: showTransition ? `opacity ${TRANSITION_DURATION}ms ease-in-out` : undefined,
          opacity: activeLayer === 'a' ? (layerAStyle.opacity ?? 1) : 0,
          zIndex: 0,
        }}
      />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          ...layerBStyle,
          transition: showTransition ? `opacity ${TRANSITION_DURATION}ms ease-in-out` : undefined,
          opacity: activeLayer === 'b' ? (layerBStyle.opacity ?? 1) : 0,
          zIndex: 0,
        }}
      />
      <div
        aria-hidden
        className={cn(
          'absolute inset-0 overflow-hidden bg-muted transition-opacity duration-500 ease-out motion-reduce:transition-none',
          backgroundReady ? 'pointer-events-none opacity-0' : 'opacity-100'
        )}
      >
        <div className="absolute inset-0 scale-110 blur-2xl" style={placeholderStyle} />
        {!backgroundReady && <div className="canvas-stage-shimmer absolute inset-0" />}
      </div>
      <Input
        accept="image/jpeg,image/png,image/webp"
        aria-label="Upload image"
        className="sr-only"
        id="editor-image-upload"
        multiple
        onChange={onFileInputChange}
        type="file"
      />

      <Label
        htmlFor="editor-image-upload"
        className={cn(
          'relative z-10 flex flex-col items-center justify-center cursor-pointer',
          // A panel of its own: the chosen background can be anything behind this text.
          'rounded-2xl bg-background/85 p-6 ring-1 ring-foreground/10 backdrop-blur-md',
          'group/upload transition-transform duration-100 ease-out active:scale-[0.98]',
          active && 'scale-[1.01]'
        )}
      >
        <svg
          width="44"
          height="44"
          viewBox="0 0 48 48"
          fill="none"
          className={cn(
            'mb-4 drop-shadow-sm transition-transform duration-100 ease-out group-active/upload:scale-[0.92]',
            active ? 'text-foreground' : 'text-foreground/85'
          )}
        >
          <line
            x1="24"
            y1="8"
            x2="24"
            y2="40"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <line
            x1="8"
            y1="24"
            x2="40"
            y2="24"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>

        <p
          className="text-sm font-medium text-center text-foreground mb-2"
        >
          {active ? 'Drop the image here...' : 'Drag & drop, click to browse, or paste'}
        </p>

        {!active && (
          <div className="flex items-center gap-1.5 text-xs text-foreground/75 mb-5">
            <kbd className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-foreground/10 border border-foreground/20 text-foreground/70 font-medium">
              <CommandIcon size={10} />V
            </kbd>
            <span>to paste</span>
          </div>
        )}

        {!active && (
          <div
            className="flex flex-col items-center gap-3 w-full max-w-[320px]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2.5 w-full max-w-[120px]">
              <div className="flex-1 h-px bg-foreground/20" />
              <span className="text-[10px] text-foreground/75">or</span>
              <div className="flex-1 h-px bg-foreground/20" />
            </div>

            <Button
              variant="outline"
              onClick={() => {
                const id = addTextOverlay()
                useImageStore.getState().setSelectedTextId(id)
                requestTextEdit(id)
              }}
            >
              Start with text
            </Button>

            <div className="flex items-center gap-2 w-full">
              <div className="flex flex-1 min-w-0 items-center gap-0 h-10 rounded-xl bg-background/80 border border-foreground/15 backdrop-blur-md focus-within:border-foreground/30 focus-within:ring-1 focus-within:ring-foreground/20 transition-[border-color,box-shadow]">
                <Globe02Icon size={14} className="shrink-0 ml-3 text-foreground/75" />
                <Input
                  type="url"
                  placeholder="Enter website URL..."
                  value={screenshotUrl}
                  onChange={(event) => setScreenshotUrl(event.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCaptureScreenshot()}
                  disabled={isCapturing}
                  className="h-full flex-1 min-w-0 border-0 bg-transparent px-2 text-xs text-foreground/90 placeholder:text-foreground/70 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 dark:bg-transparent"
                />
                <div className="h-4 w-px shrink-0 bg-foreground/15" />
                <SegmentedControl
                  size="sm"
                  value={colorScheme}
                  onChange={(value) => setColorScheme(value as ColorScheme)}
                  className={cn(
                    'mx-1 shrink-0 h-7 w-[58px] border-0 bg-transparent p-0.5',
                    isCapturing && 'pointer-events-none opacity-60'
                  )}
                  indicatorClassName="bg-foreground/20 shadow-none"
                  options={[
                    { id: 'light', icon: <Sun className="h-3 w-3" />, ariaLabel: 'Light' },
                    { id: 'dark', icon: <Moon className="h-3 w-3" />, ariaLabel: 'Dark' },
                  ]}
                />
              </div>

              <Button
                onClick={handleCaptureScreenshot}
                disabled={isCapturing}
                variant="outline"
                size="icon"
                aria-label="Capture screenshot"
                className="size-10 shrink-0 rounded-xl border-foreground/15 bg-background/80 text-foreground/80 backdrop-blur-md hover:bg-background/45 hover:text-foreground hover:border-foreground/25"
              >
                {isCapturing ? (
                  <Loading03Icon size={16} className="animate-spin" />
                ) : (
                  <Camera01Icon size={16} />
                )}
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div className="mt-4 text-sm text-destructive bg-background/70 backdrop-blur-sm px-3 py-1.5 rounded-lg border border-destructive/30">
            {error}
          </div>
        )}
      </Label>
    </div>
  )
}
