'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useAssistantAbility, useAssistantPage } from '@/components/assistant/AssistantProvider'
import {
  type ClientToolExecutor,
  runUnifiedAssistant,
} from '@/components/assistant/run-unified-assistant'
import { commandExecutor } from '@/components/assistant/use-surface-ability'
import { applyToSession } from '@/lib/assistant/surface-edits'
import {
  createScreenshotEditorToolExecutor,
  SCREENSHOT_EDITOR_CLIENT_TOOLS,
} from '@/components/editor-ai/useScreenshotEditorAbility'
import { boardEditSchema } from '@/lib/assistant/surface-commands'
import { applyCanvasCommand, type CanvasCommand } from '@/lib/canvas/commands'
import type { Artboard } from '@/lib/canvas/document'
import type { CanvasSession } from '@/lib/canvas/session'
import { artboardRect } from '@/lib/canvas/document'
import { readingOrder } from '@/lib/canvas/layout'
import { useCanvasUi } from '@/lib/canvas/ui-store'
import { useTRPCClient } from '@/lib/trpc/react'
import {
  ACROSS_ARTBOARDS,
  ACROSS_ARTBOARDS_MAX,
  type EditorOpenState,
  type WaitStep,
  waitForArtboard,
} from '@/lib/canvas/copilot-wait'

/**
 * The canvas's assistant ability and page context. The screenshot editor's
 * copilot edits one artboard: the open one, else the selected, else the
 * first. An artboard loads into the editor while open for editing, and the
 * canvas saves what the editor changes (NativeDocumentBridge), so a request
 * opens its artboard first and runs only on it: it stops if that artboard
 * closes, and leaves undo to the canvas's ⌘Z.
 */
export function useCanvasCopilot({
  session,
  canvas,
  artboards,
  activeId,
  ready,
  error,
  enabled,
  onEdit,
}: {
  session: CanvasSession
  canvas: { id: string; name: string }
  artboards: Artboard[]
  activeId: string | null
  /** The open artboard is loaded in the editor and its changes are saved. */
  ready: boolean
  /** Why the open artboard could not load in the editor. */
  error: string | null
  /** The member may edit here (and is not on a phone). */
  enabled: boolean
  onEdit: (id: string) => void
}) {
  const trpcClient = useTRPCClient()
  const boardTool = commandExecutor<CanvasCommand>({
    apply: (commands) => applyToSession(session, applyCanvasCommand, commands),
    editSchema: boardEditSchema,
    editTool: 'editBoard',
    inspect: () =>
      session.snapshot().document.artboards.map((item) => ({
        id: item.id,
        name: item.name,
        ...artboardRect(item),
      })),
    inspectTool: 'inspectBoard',
  })
  const board = useRef(boardTool)
  useEffect(() => {
    board.current = boardTool
  })
  const selection = useCanvasUi((ui) => ui.selection)
  const executeClientTool = useMemo(
    (): ClientToolExecutor => {
      const artboard = createScreenshotEditorToolExecutor(trpcClient, { canUndo: false })
      return (call, context) =>
        call.toolName === 'inspectBoard' || call.toolName === 'editBoard'
          ? board.current(call, context)
          : artboard(call, context)
    },
    [trpcClient]
  )
  const order = useMemo(
    () => readingOrder(artboards.map((item) => ({ id: item.id, rect: artboardRect(item) }))),
    [artboards]
  )
  const targetId =
    activeId ?? selection.find((id) => artboards.some((item) => item.id === id)) ?? order[0]?.id
  const target = artboards.find((item) => item.id === targetId)
  const number = order.findIndex((item) => item.id === targetId) + 1
  const open = artboards.find((item) => item.id === activeId)

  // The editor's state, for requests waiting on their artboard to open.
  const editor = useRef<EditorOpenState>({ activeId, ready, error, mounted: true })
  const waiters = useRef(new Set<() => void>())
  useEffect(() => {
    editor.current = { activeId, ready, error, mounted: true }
    for (const check of [...waiters.current]) check()
  }, [activeId, ready, error])
  // Leaving the canvas ends any request still waiting for its artboard.
  useEffect(
    () => () => {
      editor.current = { ...editor.current, mounted: false }
      for (const check of [...waiters.current]) check()
    },
    []
  )

  // A run stops when its artboard stops being the open one, or the canvas closes.
  const running = useRef<{ id: string; controller: AbortController } | null>(null)
  // The artboard the conversation's memory is about; another starts the model afresh.
  const remembered = useRef<string | null>(null)
  useEffect(() => {
    if (running.current && running.current.id !== activeId)
      running.current.controller.abort(new Error('Stopped: the artboard was closed.'))
  }, [activeId])
  useEffect(() => () => running.current?.controller.abort(new Error('Stopped.')), [])

  /** Resolves once artboard `id` is open and loaded; rejects if another opens, it fails, or the canvas closes. */
  const opened = (id: string, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      let seen = editor.current.activeId === id
      // The artboard open now may stay open until the editor switches to `id`.
      const from = seen ? null : editor.current.activeId
      function check() {
        const step: WaitStep = signal.aborted
          ? { kind: 'fail', message: 'Stopped.' }
          : waitForArtboard(editor.current, id, seen, from)
        if (step.kind === 'wait') {
          seen = step.seen
          return
        }
        waiters.current.delete(check)
        signal.removeEventListener('abort', check)
        if (step.kind === 'start') resolve()
        else reject(new Error(step.message))
      }
      waiters.current.add(check)
      signal.addEventListener('abort', check)
      check()
    })

  useAssistantAbility(
    enabled && target
      ? {
          // One conversation per canvas, so a run across artboards keeps its thread.
          id: `canvas:${canvas.id}`,
          label: `Artboard ${number} · ${target.name}`,
          placeholder:
            order.length > 1
              ? `Ask AI to change artboard ${number}, or every artboard`
              : `Ask AI to change artboard ${number}`,
          priority: 10,
          prominent: true,
          surface: 'canvas',
          ...(activeId ? { target: activeId } : {}),
          suggestions: [
            'Make the headline punchier',
            'Try a bolder background',
            ...(order.length > 1
              ? ['Make the headline punchier on every artboard']
              : ['Give the screenshot a soft shadow']),
          ],
          run: async ({ ask, images, memory, page, push, signal, stream }) => {
            // "every artboard", "all the slides", "each page": the request runs on each in turn,
            // up to a cap, so a misread request cannot run on (and charge for) a whole deck.
            const across = ACROSS_ARTBOARDS.test(ask)
            const all = across ? order.map((item) => item.id) : [target.id]
            const ids = all.slice(0, ACROSS_ARTBOARDS_MAX)
            if (all.length > ids.length)
              push({
                kind: 'note',
                text: `Running on the first ${ids.length} of ${all.length} artboards; ask again for the rest.`,
              })
            for (const id of ids) {
              if (signal.aborted) throw new Error('Stopped.')
              const at = order.findIndex((item) => item.id === id) + 1
              if (ids.length > 1) push({ kind: 'note', text: `Artboard ${at} of ${ids.length}…` })
              if (editor.current.activeId !== id || !editor.current.ready) {
                if (editor.current.activeId !== id) onEdit(id)
                if (ids.length === 1) push({ kind: 'note', text: `Opening artboard ${at}…` })
                await opened(id, signal)
              }
              const controller = new AbortController()
              const stop = () => controller.abort(signal.reason)
              signal.addEventListener('abort', stop)
              running.current = { id, controller }
              // Memory follows one artboard, so one's edits never steer another's.
              // A resumed chat has memory before any artboard ran; keep it.
              if (remembered.current !== null && remembered.current !== id) memory.current = []
              remembered.current = id
              try {
                await runUnifiedAssistant({
                  ask,
                  images,
                  clientTools: [...SCREENSHOT_EDITOR_CLIENT_TOOLS, 'inspectBoard', 'editBoard'],
                  executeClientTool,
                  memory,
                  page,
                  push: (entry) => {
                    // Cards act on the live editor, so each stays with its artboard.
                    push({ ...entry, target: id })
                  },
                  selection: null,
                  signal: controller.signal,
                  stream,
                })
              } finally {
                signal.removeEventListener('abort', stop)
                if (running.current?.controller === controller) running.current = null
              }
              if (controller.signal.aborted) return
            }
            if (ids.length > 1) push({ kind: 'note', text: `Done: ${ids.length} artboards.` })
          },
        }
      : null
  )

  useAssistantPage({
    entities: [
      { id: canvas.id, name: canvas.name, type: 'canvas' },
      ...(open ? [{ id: open.id, name: open.name, type: 'artboard' }] : []),
    ],
    facts: [
      `A canvas with ${artboards.length} artboard${artboards.length === 1 ? '' : 's'}: ${order
        .slice(0, 8)
        .map((item, index) => {
          const artboard = artboards.find((entry) => entry.id === item.id)
          return `${index + 1} "${artboard?.name ?? ''}" ${Math.round(item.rect.width)}×${Math.round(item.rect.height)}`
        })
        .join(', ')}`,
      open ? `Artboard "${open.name}" is open for editing.` : 'No artboard is open for editing.',
    ],
  })
}
