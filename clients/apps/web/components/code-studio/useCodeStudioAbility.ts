'use client'

import { useEffect, useRef } from 'react'
import { commandExecutor, useSurfaceAbility } from '@/components/assistant/use-surface-ability'
import { codeSceneEditSchema } from '@/lib/assistant/surface-commands'
import { applyCodeCommand, CODE_EDIT_MAX, type CodeCommand } from '@/lib/code-studio/commands'
import { activeFile, type CodeDocument } from '@/lib/code-studio/document'

/** Registers Code Studio with the assistant: read the scene, and edit it in one change. */
export function useCodeStudioAbility({
  canEdit,
  document,
  name,
  onChange,
  projectId,
  slide,
}: {
  canEdit: boolean
  document: CodeDocument
  name: string
  onChange: (next: CodeDocument) => void
  projectId: string | null | undefined
  slide: number
}) {
  const live = useRef(document)
  useEffect(() => {
    live.current = document
  }, [document])
  const change = (next: CodeDocument) => {
    live.current = next
    onChange(next)
  }
  useSurfaceAbility({
    active: canEdit,
    entity: { id: projectId ?? 'draft', name, type: 'code-project' },
    // Built per call, so the refs are read when a tool runs, never during render.
    executeClientTool: (call, context) => commandExecutor<CodeCommand>({
      apply: (commands) => {
        const before = live.current
        const after = commands.reduce(applyCodeCommand, before)
        change(after)
        // By content: autosave replaces the object without changing the work.
        const saved = JSON.stringify(after)
        return {
          isNewest: () => JSON.stringify(live.current) === saved,
          undo: () => change(before),
        }
      },
      editSchema: codeSceneEditSchema,
      editTool: 'editCodeScene',
      inspect: () => ({
        activeSlide: slide,
        slides: live.current.slides.map((item, index) => ({
          caption: item.caption,
          index,
          layout: item.layout,
          panes: item.panes.map((pane) => {
            const file = activeFile(pane)
            return {
              code: file.code.slice(0, CODE_EDIT_MAX),
              file: file.name,
              language: file.lang,
              truncated: file.code.length > CODE_EDIT_MAX,
            }
          }),
        })),
      }),
      inspectTool: 'inspectCodeScene',
    })(call, context),
    facts: [`A code project with ${document.slides.length} slides. Slide ${slide} is open.`],
    label: 'Code Studio',
    placeholder: 'Ask to change the code, highlight lines, or animate a step',
    quickActions: [
      {
        id: 'diff',
        label: 'Animated step',
        prompt: 'Add a next step as a new slide that animates the most important change.',
      },
      { id: 'focus', label: 'Highlight', prompt: 'Highlight the key lines of the open slide.' },
      { id: 'caption', label: 'Caption', prompt: 'Write a short developer caption for each slide.' },
    ],
    surface: 'code-studio',
    tools: ['inspectCodeScene', 'editCodeScene'],
  })
}
