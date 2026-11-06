'use client'

import { publicImageUrl } from '@/lib/assets/public-image'

import * as React from 'react'
import { toast } from 'sonner'
import Link from 'next/link'
import Image from 'next/image'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DownloadIcon as Download04Icon } from '@phosphor-icons/react/dist/ssr/Download'
import { CopyIcon as Copy01Icon } from '@phosphor-icons/react/dist/ssr/Copy'
import { RectangleIcon as AspectRatioIcon } from '@phosphor-icons/react/dist/ssr/Rectangle'
import { PlusIcon as Add01Icon } from '@phosphor-icons/react/dist/ssr/Plus'
import { VideoIcon as Video01Icon } from '@phosphor-icons/react/dist/ssr/Video'
import { TrashIcon as Delete02Icon } from '@phosphor-icons/react/dist/ssr/Trash'
import { ArrowBendUpLeftIcon as ArrowTurnBackwardIcon } from '@phosphor-icons/react/dist/ssr/ArrowBendUpLeft'
import { ArrowBendUpRightIcon as ArrowTurnForwardIcon } from '@phosphor-icons/react/dist/ssr/ArrowBendUpRight'
import { ArrowsClockwiseIcon as RefreshIcon } from '@phosphor-icons/react/dist/ssr/ArrowsClockwise'
import { MagicWandIcon as MagicWand01Icon } from '@phosphor-icons/react/dist/ssr/MagicWand'
import { SquaresFourIcon as GridIcon } from '@phosphor-icons/react/dist/ssr/SquaresFour'
import { KeyboardIcon as KeyboardIcon } from '@phosphor-icons/react/dist/ssr/Keyboard'
import { DotsThreeIcon as MoreHorizontalIcon } from '@phosphor-icons/react/dist/ssr/DotsThree'
import { selectScreenshot, useImageStore } from '@/lib/store'
import { useShallow } from 'zustand/react/shallow'
import { useExport } from '@/hooks/useExport'
import { shouldIgnoreEditorShortcut } from '@/lib/editor-shortcuts'
import { KeyboardShortcutsDialog } from '@/components/canvas/dialogs/KeyboardShortcutsDialog'
import { aspectRatios } from '@/lib/constants/aspect-ratios'
import { AspectRatioPicker } from '@/components/aspect-ratio/aspect-ratio-picker'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { CopyProgressDialog } from '@/components/canvas/dialogs/CopyProgressDialog'
import { ExportSlideshowDialog } from '@/lib/export-slideshow-dialog'
import { useExportSettings } from '@/lib/export/use-export-settings'
import { formatHasControl } from '@/lib/export/formats'
import { ExportPanel } from '@/components/export/ExportPanel'
import { BatchWorkspace } from '@/components/export/batch/BatchWorkspace'
import { useLibraryStyleSources } from '@/components/export/batch/use-library-styles'
import { cn } from '@/lib/utils'
import { ProjectMenu } from '@/components/projects/ProjectMenu'
import { ShareButton } from './share/ShareButton'
import { FeedbackWidget } from '@/components/FeedbackWidget'
import { AccountMenu } from '@/components/auth/AccountMenu'
import { useIsMobile } from '@/hooks/use-mobile'
import { hasVisibleMockups, shouldRenderSourceImage } from '@/lib/device-mockups/layouts'
import { removeScreenshot } from '@/lib/editor/remove-screenshot'
import { importImages } from '@/lib/editor/import-images'
import { hasMotionContent } from '@/lib/animation/motion-schema'
import { hasCanvasContent } from '@/lib/editor/canvas-content'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

/** A quiet square toolbar button with a tooltip; `active` marks a toggled tool. */
function ToolButton({
  active = false,
  children,
  className,
  label,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="custom" size={null}
          aria-label={label}
          aria-pressed={props['aria-pressed']}
          className={cn(
            'grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-muted-foreground',
            'transition-[color,background-color,transform] duration-150 hover:bg-foreground/[0.06] hover:text-foreground active:scale-95',
            'disabled:pointer-events-none disabled:opacity-35',
            active && 'bg-foreground/[0.08] text-foreground',
            className
          )}
          type="button"
          {...props}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

/** A hairline between toolbar groups. */
function ToolDivider() {
  return <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-foreground/[0.08]" />
}

export function EditorHeader() {
  const isMobile = useIsMobile()
  const [exportSettings] = useExportSettings()
  const addSlideInputRef = React.useRef<HTMLInputElement>(null)
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false)
  const screenshot = useImageStore(useShallow(selectScreenshot))
  const {
    selectedAspectRatio,
    customDimensions,
    slides,
    uploadedImageUrl,
    editorMode,
    mockups,
    timeline,
    animationClips,
    resetCanvasSettings,
    showTemplates,
    setShowTemplates,
    showRulers,
    showGrid,
    rulerInterval,
    toggleRulers,
    toggleGrid,
    setRulerInterval,
  } = useImageStore()
  const [aspectRatioOpen, setAspectRatioOpen] = React.useState(false)
  const [exportOpen, setExportOpen] = React.useState(false)
  const [exportSlideshowOpen, setExportSlideshowOpen] = React.useState(false)
  const [exportBusy, setExportBusy] = React.useState(false)
  const [batchOpen, setBatchOpen] = React.useState(false)
  const libraryStyles = useLibraryStyleSources(batchOpen)
  const [resetOpen, setResetOpen] = React.useState(false)

  const currentAspectRatio = aspectRatios.find((ar) => ar.id === selectedAspectRatio)
  const hasImage =
    (!!screenshot.src && shouldRenderSourceImage(editorMode, mockups)) ||
    (editorMode === 'device' && hasVisibleMockups(mockups))

  const hasContent = useImageStore(hasCanvasContent)

  // Undo/redo state
  const [canUndo, setCanUndo] = React.useState(false)
  const [canRedo, setCanRedo] = React.useState(false)
  const showHistoryControls = hasImage || canUndo || canRedo

  React.useEffect(() => {
    const updateTemporalState = () => {
      const { pastStates, futureStates } = useImageStore.temporal.getState()
      setCanUndo(pastStates.length > 0)
      setCanRedo(futureStates.length > 0)
    }
    updateTemporalState()
    const unsubscribe = useImageStore.temporal.subscribe(updateTemporalState)
    return unsubscribe
  }, [])

  const handleUndo = React.useCallback(() => {
    const { undo, pastStates } = useImageStore.temporal.getState()
    if (pastStates.length > 0) undo()
  }, [])

  const handleRedo = React.useCallback(() => {
    const { redo, futureStates } = useImageStore.temporal.getState()
    if (futureStates.length > 0) redo()
  }, [])

  // Keep history shortcuts mounted even when undo/delete empties the canvas.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreEditorShortcut(event) || event.altKey || !(event.metaKey || event.ctrlKey))
        return
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      event.preventDefault()
      if (key === 'y' || event.shiftKey) handleRedo()
      else handleUndo()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleUndo, handleRedo])

  const hasMotion = useImageStore((state) => hasMotionContent(state.motion))
  const showVideoExport =
    slides.length > 0 || timeline.tracks.length > 0 || animationClips.length > 0 || hasMotion

  const { copyImage, isCopying, copyProgress, renderExportBlob } = useExport(selectedAspectRatio)
  const [shareOpen, setShareOpen] = React.useState(false)

  return (
    <>
      <header
        className={cn(
          'grid shrink-0 items-center gap-2 border-b border-foreground/[0.06] bg-background',
          isMobile ? 'grid-cols-[1fr_auto] px-2 py-2' : 'h-12 grid-cols-[minmax(0,1fr)_auto_auto] px-3'
        )}
      >
        <div className="flex min-w-0 items-center gap-1 overflow-hidden justify-self-stretch">
          {/* On desktop the logo lives in the sidebar rail. */}
          {isMobile ? (
            <Link
              aria-label="Shots"
              className="grid size-8 shrink-0 place-items-center rounded-lg transition-opacity hover:opacity-80"
              href="/"
            >
              <Image
                alt=""
                className="size-6 rounded-md"
                height={24}
                priority
                src={publicImageUrl("/logo-mark.png")}
                width={24}
              />
            </Link>
          ) : null}
          <Button variant="custom" size={null}
            aria-expanded={showTemplates}
            aria-label="Templates"
            className={cn(
              'inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium',
              'transition-colors duration-150',
              showTemplates
                ? 'bg-foreground/[0.08] text-foreground'
                : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground'
            )}
            id="editor-templates-trigger"
            onClick={() => setShowTemplates(!showTemplates)}
            type="button"
          >
            <MagicWand01Icon className="shrink-0" size={15} />
            {!isMobile ? <span>Templates</span> : null}
          </Button>
          <ProjectMenu compact={isMobile} />
        </div>

        {/* One floating toolbar: history, guides, and canvas size. */}
        <div className={cn(
          'flex items-center justify-self-center rounded-xl border border-foreground/[0.06] bg-foreground/[0.03] p-0.5',
          isMobile && 'order-3 col-span-2'
        )}>
          {showHistoryControls ? (
            <>
              <ToolButton disabled={!canUndo} label="Undo (⌘Z)" onClick={handleUndo}>
                <ArrowTurnBackwardIcon size={15} />
              </ToolButton>
              <ToolButton disabled={!canRedo} label="Redo (⌘⇧Z)" onClick={handleRedo}>
                <ArrowTurnForwardIcon size={15} />
              </ToolButton>
              <ToolDivider />
            </>
          ) : null}

          {hasImage && !isMobile ? (
            <>
              <ToolButton
                active={showRulers}
                aria-pressed={showRulers}
                label="Toggle rulers"
                onClick={toggleRulers}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="2" y="7" width="20" height="10" rx="1" /><path d="M6 7v6m4-6v3m4-3v6m4-6v3" /></svg>
              </ToolButton>
              <span className={showRulers ? 'inline-flex w-16' : 'invisible inline-flex w-16'} aria-hidden={!showRulers}>
                <Select
                  onValueChange={(nextValue) => setRulerInterval(Number(nextValue))}
                  value={String(rulerInterval)}
                >
                  <SelectTrigger
                    className="h-7 shrink-0 cursor-pointer rounded-md border-0 bg-transparent px-1 text-[11px] text-muted-foreground outline-none hover:text-foreground"
                    disabled={!showRulers}
                    title="Ruler interval"
                    aria-label={'Ruler interval'}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={String(25)}>25px</SelectItem>
                    <SelectItem value={String(50)}>50px</SelectItem>
                    <SelectItem value={String(100)}>100px</SelectItem>
                    <SelectItem value={String(200)}>200px</SelectItem>
                  </SelectContent>
                </Select>
              </span>
              <ToolButton
                active={showGrid}
                aria-pressed={showGrid}
                label="Toggle grid"
                onClick={toggleGrid}
              >
                <GridIcon size={15} />
              </ToolButton>
              <ToolDivider />
            </>
          ) : null}

          <Popover onOpenChange={setAspectRatioOpen} open={aspectRatioOpen}>
            <PopoverTrigger asChild>
              <Button variant="custom" size={null}
                className={cn(
                  'inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg text-muted-foreground',
                  'transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground',
                  isMobile ? 'px-2' : 'px-2.5'
                )}
                type="button"
              >
                <AspectRatioIcon size={15} />
                <span className="font-mono text-xs leading-none tabular-nums">
                  {selectedAspectRatio === 'custom' && customDimensions
                    ? `${customDimensions.width} × ${customDimensions.height}`
                    : currentAspectRatio
                      ? `${currentAspectRatio.width}:${currentAspectRatio.height}`
                      : 'Auto'}
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="center"
              className="w-[420px] max-w-[calc(100vw-2rem)] p-0"
              collisionPadding={16}
              sideOffset={10}
            >
              <AspectRatioPicker onSelect={() => setAspectRatioOpen(false)} />
            </PopoverContent>
          </Popover>

          {!isMobile || !hasImage ? (
            <div className="inline-flex shrink-0">
              <Input
                ref={addSlideInputRef}
                accept="image/png,image/jpeg,image/webp"
                aria-label="Add slides"
                className="hidden"
                multiple
                onChange={async (e) => {
                  const files = Array.from(e.target.files ?? [])
                  e.target.value = ''
                  try {
                    const result = await importImages(files, true)
                    for (const rejected of result.rejected) toast.error(rejected.reason)
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : 'The image could not be imported.')
                  }
                }}
                type="file"
              />
              <Button variant="custom" size={null} type="button" onClick={() => addSlideInputRef.current?.click()} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium leading-none text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground">
                <Add01Icon size={14} />
                <span>{hasImage ? 'Add slide from image…' : 'Upload image…'}</span>
              </Button>
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-1 justify-self-end">
          {hasContent && !isMobile ? (
            <ToolButton className="hover:text-destructive" label="Remove screenshot" disabled={!uploadedImageUrl} onClick={removeScreenshot}>
              <Delete02Icon size={15} />
            </ToolButton>
          ) : null}
          <ToolButton
            disabled={!hasContent || exportBusy || isCopying}
            label="Copy image to clipboard"
            onClick={() => copyImage()}
          >
            <Copy01Icon size={15} />
          </ToolButton>

          {hasImage && showVideoExport && !isMobile ? (
            <Button variant="custom" size={null}
              aria-label="Export Video"
              className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-foreground/[0.08] px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.06]"
              onClick={() => setExportSlideshowOpen(true)}
              type="button"
            >
              <Video01Icon size={14} />
              <span className="hidden xl:inline">Export Video</span>
            </Button>
          ) : null}

          <ShareButton
            compact={isMobile}
            disabled={!hasContent}
            onOpenChange={setShareOpen}
            open={shareOpen}
            render={renderExportBlob}
          />

          {/* The AI copilot, which fork code renders here without this file knowing it. */}
          <span className="contents" id="editor-header-slot" />

          <Popover onOpenChange={exportBusy ? undefined : setExportOpen} open={exportOpen}>
            <PopoverTrigger asChild>
              <Button variant="custom" size={null}
                aria-label="Export"
                className={cn(
                  'inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-foreground text-[13px] font-medium text-background',
                  'transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.98]',
                  'disabled:pointer-events-none disabled:opacity-35',
                  isMobile ? 'px-2' : 'px-3'
                )}
                disabled={!hasContent}
                type="button"
              >
                <Download04Icon size={15} />
                {!isMobile ? <span>Export{exportSettings.transparent && formatHasControl(exportSettings.format, 'transparency') ? ' · Transparent' : ''}</span> : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="w-[340px] p-0"
              collisionPadding={16}
              onPointerDownOutside={exportBusy ? (e) => e.preventDefault() : undefined}
              sideOffset={10}
            >
              <ExportPanel
                embed={
                  <Button variant="custom" size={null}
                    className="flex w-full cursor-pointer items-center gap-2.5 rounded-md border border-foreground/[0.08] p-2.5 text-left text-xs transition-colors hover:bg-foreground/[0.04]"
                    onClick={() => {
                      setExportOpen(false)
                      setShareOpen(true)
                    }}
                    type="button"
                  >
                    <span>
                      <span className="block font-medium text-foreground">Embed or share a link</span>
                      <span className="block text-muted-foreground">Publish this design, then copy an iframe, HTML, or Markdown embed.</span>
                    </span>
                  </Button>
                }
                onBusyChange={setExportBusy}
                onExported={() => setExportOpen(false)}
                onOpenBatch={() => {
                  setExportOpen(false)
                  setBatchOpen(true)
                }}
              />
            </PopoverContent>
          </Popover>

          {!isMobile ? (
            <ToolButton label="Keyboard shortcuts" onClick={() => setShortcutsOpen(true)}>
              <KeyboardIcon size={15} />
            </ToolButton>
          ) : null}

          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button variant="custom" size={null}
                    aria-label="More"
                    className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground data-[state=open]:bg-foreground/[0.08] data-[state=open]:text-foreground"
                    type="button"
                  >
                    <MoreHorizontalIcon size={16} />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">More</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-52" sideOffset={8}>
              <DropdownMenuItem onSelect={() => setShortcutsOpen(true)}>
                <KeyboardIcon size={15} />
                Keyboard shortcuts
              </DropdownMenuItem>
              {hasContent || uploadedImageUrl ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setResetOpen(true)} variant="destructive">
                    <RefreshIcon size={15} />
                    Start over
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>

          {!isMobile ? <FeedbackWidget /> : null}
          <span className="[[data-platform-shell]_&]:hidden"><AccountMenu /></span>
        </div>
      </header>

      <AlertDialog onOpenChange={setResetOpen} open={resetOpen}>
        <AlertDialogContent className="sm:max-w-[420px]">
          <AlertDialogHeader>
            <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive sm:mx-0">
              <RefreshIcon aria-hidden="true" size={18} />
            </div>
            <AlertDialogTitle>Start over?</AlertDialogTitle>
            <AlertDialogDescription>
              This resets the design: background, frame, text, stickers, markup, devices, and
              animation. Your screenshots stay, and you can undo it with ⌘Z.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive/30"
              onClick={resetCanvasSettings}
            >
              Start over
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

      <CopyProgressDialog open={isCopying} progress={copyProgress} />

      <ExportSlideshowDialog open={exportSlideshowOpen} onOpenChange={setExportSlideshowOpen} />

      <BatchWorkspace onOpenChange={setBatchOpen} open={batchOpen} styleSources={libraryStyles} />
    </>
  )
}
