'use client'

import * as React from 'react'
import dynamic from 'next/dynamic'
import { ComposePanel, InspectorPanel } from './panels/EditorPanel'
import { EditorContent } from './EditorContent'
import { EditorCanvas } from '@/components/canvas/EditorCanvas'
import { EditorPlatformLayer } from '@/components/editor-ai/EditorPlatformLayer'
import { EditorHeader } from './EditorHeader'
import { useIsMobile } from '@/hooks/use-mobile'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { SlidersHorizontalIcon as Settings02Icon } from '@phosphor-icons/react/dist/ssr/SlidersHorizontal'
import { UploadIcon as Upload01Icon } from '@phosphor-icons/react/dist/ssr/Upload'
import { FilmScriptIcon as VideoReplayIcon } from '@phosphor-icons/react/dist/ssr/FilmScript'
import { useAutosaveDraft } from '@/hooks/useAutosaveDraft'
import { useHistoryGestures } from '@/lib/editor/history-gestures'
import { MobileBanner } from './MobileBanner'
import { useImageStore } from '@/lib/store'
import { trackEditorOpen } from '@/lib/analytics'
import { cn } from '@/lib/utils'
import { hasVisibleMockups, shouldRenderSourceImage } from '@/lib/device-mockups/layouts'
import { SidebarSimpleIcon } from '@phosphor-icons/react/dist/ssr/SidebarSimple'
import { TemplateLibraryDrawer } from '@/components/templates/TemplateLibraryDrawer'
import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_SIZE } from '@/lib/constants'
import { useDeviceUIStore } from '@/lib/store/device-ui'
import { hasTemplateDemoMedia, isTemplateDemoMedia } from '@/lib/templates/demo-media'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'

const TimelineEditor = dynamic(
  () => import('@/components/timeline').then((module) => module.TimelineEditor),
  { ssr: false }
)

const MobilePanel = dynamic(
  () => import('./panels/EditorPanel').then((module) => module.MobilePanel),
  { ssr: false }
)

function TemplateMediaPrompt() {
  const imageName = useImageStore((state) => state.imageName)
  const uploadedImageUrl = useImageStore((state) => state.uploadedImageUrl)
  const editorMode = useImageStore((state) => state.editorMode)
  const mockups = useImageStore((state) => state.mockups)
  const replaceTemplateMedia = useImageStore((state) => state.replaceTemplateMedia)
  const selectedDeviceId = useDeviceUIStore((state) => state.selectedDeviceId)
  const [error, setError] = React.useState<string | null>(null)
  const isUsingTemplateDemo =
    editorMode === 'device'
      ? hasTemplateDemoMedia(mockups.map((mockup) => mockup.screen))
      : isTemplateDemoMedia(uploadedImageUrl, imageName)

  if (!isUsingTemplateDemo) return null

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    if (!ALLOWED_IMAGE_TYPES.includes(file.type) || file.size > MAX_IMAGE_SIZE) {
      setError(`Choose a PNG, JPG, or WEBP under ${MAX_IMAGE_SIZE / 1024 / 1024} MB`)
      return
    }

    setError(null)

    const target =
      editorMode === 'device'
        ? (mockups.find((mockup) => mockup.id === selectedDeviceId) ??
          mockups.find((mockup) => isTemplateDemoMedia(mockup.screen.src, mockup.screen.name)) ??
          mockups[0])
        : null
    if (editorMode === 'device' && !target) return

    const previousState = useImageStore.getState()
    const previousBlobUrls = new Set(
      [
        previousState.uploadedImageUrl,
        ...previousState.mockups.map((mockup) => mockup.screen.src),
      ].filter((url): url is string => !!url?.startsWith('blob:'))
    )
    const src = URL.createObjectURL(file)
    const temporalStore = useImageStore.temporal.getState()

    try {
      temporalStore.pause()
      replaceTemplateMedia(src, file.name, target?.id)
      temporalStore.clear()

      const currentState = useImageStore.getState()
      const retainedUrls = new Set([
        currentState.uploadedImageUrl,
        ...currentState.mockups.map((mockup) => mockup.screen.src),
      ])
      previousBlobUrls.forEach((url) => {
        if (!retainedUrls.has(url)) URL.revokeObjectURL(url)
      })
    } catch {
      URL.revokeObjectURL(src)
      setError("Couldn't read that image. Try another file.")
    } finally {
      temporalStore.resume()
    }
  }

  return (
    <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2">
      <Label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-foreground/10 bg-card/95 px-3 text-xs font-medium text-foreground shadow-md backdrop-blur-md transition-[background-color,transform] duration-150 hover:bg-muted active:scale-[0.98]">
        <Input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(event) => void handleUpload(event)}
          className="sr-only"
        />
        <Upload01Icon size={14} />
        <span>{error ?? 'Upload your media'}</span>
      </Label>
    </div>
  )
}

function EditorMain() {
  const isMobile = useIsMobile()
  const [mobileSheetOpen, setMobileSheetOpen] = React.useState(false)
  const { uploadedImageUrl, slides, mockups, editorMode, showTimeline, toggleTimeline } =
    useImageStore()

  // enable autosave
  useAutosaveDraft()
  useHistoryGestures()

  const hasSourceContent =
    (!!uploadedImageUrl || slides.length > 0) && shouldRenderSourceImage(editorMode, mockups)
  const hasContent = hasSourceContent || (editorMode === 'device' && hasVisibleMockups(mockups))
  const [composeShown, setComposeShown] = React.useState(true)
  const [inspectorShown, setInspectorShown] = React.useState(true)
  React.useEffect(() => {
    trackEditorOpen()
  }, [])

  const handleMobileSheetOpenChange = (open: boolean): void => {
    setMobileSheetOpen(open)
  }

  return (
    <div className="h-[var(--editor-height,100dvh)] flex flex-col bg-background overflow-hidden overscroll-contain">
      <EditorPlatformLayer />

      <MobileBanner />

      <EditorHeader />
      <TemplateLibraryDrawer />

      <div className="bg-background border-b border-foreground/10 flex items-center justify-between gap-2 px-3 py-2 z-10 shrink-0 lg:hidden">
        <span />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setMobileSheetOpen(true)}
          className="h-8 gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] border border-foreground/10 bg-foreground/[0.04]"
        >
          <Settings02Icon size={15} />
          <span>Settings</span>
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className={composeShown ? 'hidden lg:contents' : 'hidden'}>
            <ComposePanel />
          </div>

          <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
            <div
              className={cn(
                'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden',
                // Dock space for the Animate chip so portrait stages don't sit under it
                hasContent && !showTimeline && !isMobile && 'pb-14'
              )}
            >
              {/* The canvas can have the whole width; both panels stay mounted to keep their state. */}
              <Button
                aria-label={composeShown ? 'Hide the tools panel' : 'Show the tools panel'}
                aria-pressed={!composeShown}
                className="absolute top-2 left-2 z-20 hidden size-8 px-0 lg:inline-flex"
                onClick={() => setComposeShown((shown) => !shown)}
                size="sm"
                variant="ghost"
              >
                <SidebarSimpleIcon aria-hidden className="size-4" />
              </Button>
              <Button
                aria-label={inspectorShown ? 'Hide the details panel' : 'Show the details panel'}
                aria-pressed={!inspectorShown}
                className="absolute top-2 right-2 z-20 hidden size-8 px-0 lg:inline-flex"
                onClick={() => setInspectorShown((shown) => !shown)}
                size="sm"
                variant="ghost"
              >
                <SidebarSimpleIcon aria-hidden className="size-4 -scale-x-100" />
              </Button>
              <EditorContent>
                <EditorCanvas />
              </EditorContent>

              <TemplateMediaPrompt />

              {hasContent && !showTimeline && !isMobile && (
                <Button variant="custom" size={null}
                  type="button"
                  onClick={toggleTimeline}
                  className={cn(
                    'absolute bottom-3 left-1/2 z-20 -translate-x-1/2',
                    'inline-flex h-9 cursor-pointer items-center gap-2 rounded-md px-4',
                    'bg-card text-sm font-medium text-foreground',
                    'border border-foreground/10',
                    'shadow-lg',
                    'transition-all duration-150 ease-out',
                    'hover:bg-muted hover:border-foreground/15',
                    'active:scale-[0.98]'
                  )}
                >
                  <VideoReplayIcon size={15} className="text-foreground" />
                  <span>Animate</span>
                </Button>
              )}
            </div>
          </div>

          <div className={inspectorShown ? 'hidden lg:contents' : 'hidden'}>
            <InspectorPanel />
          </div>

          {isMobile && (
            <Sheet open={mobileSheetOpen} onOpenChange={handleMobileSheetOpenChange}>
              <SheetContent
                side="left"
                showCloseButton={false}
                className="h-full w-full max-w-[min(100%,460px)] gap-0 overflow-hidden p-0 sm:max-w-[min(100%,460px)]"
              >
                <SheetTitle className="sr-only">Editor settings</SheetTitle>
                <MobilePanel onClose={() => handleMobileSheetOpenChange(false)} />
              </SheetContent>
            </Sheet>
          )}
        </div>

        {hasContent && showTimeline && !isMobile && <TimelineEditor />}
      </div>
    </div>
  )
}

export function EditorLayout() {
  return <EditorMain />
}
