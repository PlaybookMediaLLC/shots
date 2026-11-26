'use client'

import { SparkleIcon as AiMagicIcon } from '@phosphor-icons/react/dist/ssr/Sparkle'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { openAssistant, toggleAssistant, useAssistantStore } from '@/components/assistant/assistant-store'
import { useAiAvailable } from '@/components/assistant/useAiAvailable'
import { useEditorActive } from '@/components/platform-shell/EditorActiveContext'
import { ProjectLoader } from '@/components/projects/ProjectLoader'
import { Button } from '@/components/ui/button'
import { WorkspaceAssetLoader } from '@/components/workspace/WorkspaceAssetLoader'
import { WorkspaceDesignLoader } from '@/components/workspace/WorkspaceDesignLoader'
import { useImageStore } from '@/lib/store'
import { useScreenshotEditorAbility } from './useScreenshotEditorAbility'

/**
 * Registers the Screenshot Editor's unified AI ability and portals the header's
 * "AI" trigger into `#editor-header-slot` so clicking it toggles the exact same
 * Shots Assistant used across every page of the platform.
 */
function EditorAiBridge() {
  useScreenshotEditorAbility()
  const active = useEditorActive()
  const available = useAiAvailable()
  const isOpen = useAssistantStore((state) => state.open)
  // A layer the person picked; the main image alone is not a scope worth a button.
  const selected = useImageStore((state) =>
    Boolean(
      state.selectedTextId ||
        state.selectedOverlayId ||
        state.selectedAnnotationId ||
        state.selectedElementId ||
        state.selectedBlurId
    )
  )
  const [headerSlot, setHeaderSlot] = useState<Element | null>(null)

  useEffect(() => {
    setHeaderSlot(document.getElementById('editor-header-slot'))
  }, [])

  if (!active || !available || !headerSlot) return null

  const askAboutLayer =
    selected && !isOpen
      ? createPortal(
          <Button
            className="fixed bottom-20 left-1/2 z-40 -translate-x-1/2 gap-1.5 rounded-full shadow-[var(--shadow-popover)]"
            data-export-exclude
            onClick={() => openAssistant()}
            size="sm"
            type="button"
            variant="outline"
          >
            <AiMagicIcon className="text-violet-500 dark:text-violet-400" size={14} />
            Ask AI about this layer
          </Button>,
          document.body
        )
      : null

  const trigger = createPortal(
    <Button
      aria-expanded={isOpen}
      aria-label="Open the AI copilot"
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[0.8125rem] font-medium text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground aria-expanded:bg-foreground/[0.08] aria-expanded:text-foreground"
      onClick={() => toggleAssistant()}
      size={null}
      type="button"
      variant="custom"
    >
      <AiMagicIcon className="text-violet-500 dark:text-violet-400" size={15} />
      AI
    </Button>,
    headerSlot
  )

  return (
    <>
      {trigger}
      {askAboutLayer}
    </>
  )
}

/**
 * Everything the platform adds to the upstream editor, behind one mount
 * point: workspace deep links (?asset=, ?design=, ?project=) and the unified AI
 * bridge. Keeping it to a single line in EditorLayout keeps upstream merges conflict-free.
 */
export function EditorPlatformLayer() {
  return (
    <>
      <WorkspaceAssetLoader />
      <WorkspaceDesignLoader />
      <ProjectLoader />
      <EditorAiBridge />
    </>
  )
}
