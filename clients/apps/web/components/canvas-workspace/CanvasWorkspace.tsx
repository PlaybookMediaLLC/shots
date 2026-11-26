'use client'

import { registerNavigationGuard } from '@/lib/platform/navigation-guard'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import type { CanvasSession } from '@/lib/canvas/session'
import { artboardRect, boundsOf } from '@/lib/canvas/document'
import { buildRecipe } from '@/lib/canvas/recipes'
import { screenshotFromFile } from '@/lib/canvas/create'
import { fitRect, type Point } from '@/lib/canvas/viewport'
import {
  rememberedViewport,
  rememberViewport,
  useCanvasUi,
  useCanvasViewport,
} from '@/lib/canvas/ui-store'
import { importImages, transferImageFiles } from '@/lib/editor/import-images'
import { useImageStore } from '@/lib/store'
import { useIsMobile } from '@/hooks/use-mobile'
import { CanvasBoard } from './CanvasBoard'
import { ActiveArtboardEditor } from './ActiveArtboardEditor'
import { CanvasHeader } from './CanvasHeader'
import { LeftPanel, RightPanel } from './CanvasPanels'
import { Minimap, ZoomBar } from './BoardChrome'
import { CanvasDialogs, type CanvasDialog } from './CanvasDialogs'
import { useCanvasActions } from './use-canvas-actions'
import { useNativeArtboard } from './use-native-artboard'
import { useLayerActions } from './use-layer-actions'
import { LayerSelection } from './LayerSelection'
import { PeerMarkers, PresenceSummary, useCanvasPresence } from './CanvasPresence'
import { CanvasStoreEditor, StoreGroupsLayer } from './StoreGroups'
import { useCanvasShortcuts } from './use-canvas-shortcuts'
import { useCanvasCopilot } from './use-canvas-copilot'
import { AssistantSlot } from '@/components/assistant/AssistantProvider'

const TimelineEditor = dynamic(
  () => import('@/components/timeline/TimelineEditor').then((module) => module.TimelineEditor),
  { ssr: false }
)

/** Side panels float on the board's grey as cards, like a slides tool's comment pane. */
const FLOATING_PANEL =
  'w-[288px] shrink-0 rounded-2xl border border-black/[0.06] bg-background shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_32px_-12px_rgba(0,0,0,0.14)] dark:border-white/10'

/**
 * The open canvas: header, insert and layer tools on the left, the
 * infinite board in the centre, contextual properties on the right. Each
 * area reads only the state it draws.
 */
export function CanvasWorkspace({
  session,
  canEdit,
  canHandOff,
  notice,
  collabUrl,
  user,
}: {
  session: CanvasSession
  canEdit: boolean
  canHandOff: boolean
  notice: string | null
  collabUrl: string | null
  user: { id: string; name: string }
}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot)
  const router = useRouter()
  const isMobile = useIsMobile()
  const activeId = useCanvasUi((ui) => ui.activeId)
  const leftOpen = useCanvasUi((ui) => ui.leftOpen)
  const rightOpen = useCanvasUi((ui) => ui.rightOpen)
  const showTimeline = useImageStore((store) => store.showTimeline)
  const editingStoreId = useCanvasUi((ui) => ui.editingStore)
  const [dialog, setDialog] = useState<CanvasDialog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const editing = canEdit && !isMobile
  const native = useNativeArtboard(session, editing ? activeId : null, editing, state.loadEpoch)
  const flushNative = native.flush
  const layerActions = useLayerActions(session, native.flush, native.sync)
  const presence = useCanvasPresence(session, collabUrl, user, state.revision)
  // A member saved a newer revision: fetch it now instead of at the next poll.
  const newest = Math.max(0, ...presence.peers.map((peer) => peer.revision))
  useEffect(() => {
    if (newest > session.snapshot().revision) void session.refreshRemote(flushNative)
  }, [newest, session, flushNative])
  const flush = useCallback(() => {
    try {
      // Inline text lives in a contenteditable until blur commits its undo step.
      document.querySelector<HTMLElement>('[data-testid="inline-text-editor"]')?.blur()
      flushNative()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Correct this edit before continuing.')
      throw failure
    }
  }, [flushNative])
  const actions = useCanvasActions(session, flush)
  useCanvasCopilot({
    session,
    activeId,
    artboards: state.document.artboards,
    canvas: { id: session.record.id, name: session.record.name },
    enabled: editing,
    error: native.error,
    onEdit: (id) => actions.edit(id),
    ready: native.ready,
  })
  const active = state.document.artboards.find((artboard) => artboard.id === activeId) ?? null
  const editingStore =
    state.document.storeGroups.find((item) => item.group.id === editingStoreId) ?? null

  // Leave edit mode if the open artboard disappears (undo, a collaborator, deletion).
  useEffect(() => {
    if (activeId && !active) useCanvasUi.getState().activate(null)
    const ids = new Set(state.document.artboards.map((artboard) => artboard.id))
    const selection = useCanvasUi.getState().selection
    if (selection.some((id) => !ids.has(id)))
      useCanvasUi.getState().select(selection.filter((id) => ids.has(id)))
  }, [state.document, activeId, active])

  // First camera: where this device left it, or the whole board.
  const placed = useRef(false)
  const screen = useCanvasViewport((camera) => camera.screen)
  useEffect(() => {
    if (placed.current || screen.width <= 1) return
    placed.current = true
    const remembered = rememberedViewport(session.record.id)
    const bounds = boundsOf(session.snapshot().document.artboards.map(artboardRect))
    useCanvasViewport
      .getState()
      .setViewport(
        remembered ??
          (bounds
            ? fitRect(bounds, screen, { padding: Math.min(96, screen.width * 0.06) })
            : { panX: screen.width / 2 - 800, panY: 120, zoom: 0.5 })
      )
  }, [screen, session])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = useCanvasViewport.subscribe((camera, previous) => {
      if (camera.viewport === previous.viewport || !placed.current) return
      clearTimeout(timer)
      timer = setTimeout(() => rememberViewport(session.record.id, camera.viewport), 400)
    })
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [session])

  // Periodic refresh picks up other editors' saves and reconnects after going offline.
  useEffect(() => {
    let pointing = false
    const start = () => {
      pointing = true
    }
    const end = () => {
      pointing = false
    }
    const timer = setInterval(
      () => {
        if (
          document.visibilityState === 'hidden' ||
          pointing ||
          (document.activeElement as HTMLElement | null)?.isContentEditable ||
          document.activeElement?.closest('input,textarea,[role="dialog"]')
        )
          return
        void session.refreshRemote(flushNative)
      },
      presence.status === 'live' ? 30000 : 4000
    )
    window.addEventListener('pointerdown', start, true)
    window.addEventListener('pointerup', end, true)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pointerdown', start, true)
      window.removeEventListener('pointerup', end, true)
    }
  }, [session, flushNative, presence.status])

  useEffect(
    () =>
      registerNavigationGuard(async () => {
        flush()
        if (canEdit && !(await session.save())) throw new Error('Save the canvas before leaving.')
      }, true),
    [session, flush, canEdit]
  )

  // Leaving with unsaved work asks first; a pending native edit is committed.
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      let failed = false
      try {
        flush()
      } catch {
        failed = true
      }
      if (failed || session.snapshot().status !== 'saved') {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', leave)
    return () => window.removeEventListener('beforeunload', leave)
  }, [session, flush])

  /** Screenshots dropped or pasted: into the open artboard, or as new announcement artboards. */
  const addScreenshots = useCallback(
    async (files: File[], at?: Point) => {
      if (!files.length || !canEdit) return
      try {
        if (useCanvasUi.getState().activeId && native.ready) {
          const result = await importImages(files)
          if (result.rejected.length)
            toast.error(`${result.rejected[0]!.name}: ${result.rejected[0]!.reason}`)
          return
        }
        const shots = await Promise.all(files.slice(0, 6).map(screenshotFromFile))
        const made = shots.flatMap((shot) =>
          buildRecipe('feature-announcement', { screenshots: [shot] })
        )
        const ids = actions.addArtboards(made, { zoom: !at })
        if (at && ids.length === 1) {
          const artboard = session.snapshot().document.artboards.find((item) => item.id === ids[0])
          if (artboard) {
            const rect = artboardRect(artboard)
            actions.move([{ id: artboard.id, x: at.x - rect.width / 2, y: at.y - rect.height / 2 }])
          }
        }
      } catch (failure) {
        toast.error(failure instanceof Error ? failure.message : 'That image could not be added.')
      }
    },
    [actions, canEdit, native.ready, session]
  )
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.isContentEditable || target?.closest('input,textarea,[role="dialog"]')) return
      const files = transferImageFiles(event.clipboardData)
      if (!files.length) return
      event.preventDefault()
      void addScreenshots(files)
    }
    window.addEventListener('paste', paste)
    return () => window.removeEventListener('paste', paste)
  }, [addScreenshots])

  const openExport = useCallback(() => setDialog('export'), [])
  useCanvasShortcuts(actions, canEdit, openExport, layerActions)

  const status = state.status
  const panelProps = {
    session,
    state,
    actions,
    canEdit,
    editing: Boolean(active && native.ready),
    onDialog: setDialog,
    layerActions,
  }
  const banners = useMemo(() => {
    const message = error ?? state.error ?? state.recoveryError ?? notice
    return message
  }, [error, state.error, state.recoveryError, notice])

  return (
    <main
      className="flex h-[var(--editor-height,100dvh)] min-h-[560px] flex-col bg-[#f4f4f4] dark:bg-[#141414]"
      data-testid="canvas-workspace"
    >
      <CanvasHeader
        session={session}
        state={state}
        actions={actions}
        canEdit={canEdit}
        canHandOff={canHandOff}
        onDialog={setDialog}
        presence={<PresenceSummary status={presence.status} peers={presence.peers} />}
      />
      {banners ? (
        <div
          className="flex items-center gap-3 border-b px-4 py-2 text-sm text-destructive"
          role="alert"
        >
          <span className="min-w-0 flex-1">{banners}</span>
          {status === 'offline' || status === 'error' ? (
            <Button variant="link" size="sm" onClick={() => void session.save()}>
              Retry save
            </Button>
          ) : null}
          {error ? (
            <Button variant="ghost" size="sm" onClick={() => setError(null)}>
              Dismiss
            </Button>
          ) : null}
        </div>
      ) : null}
      {status === 'conflict' ? (
        <div
          className="flex flex-wrap items-center gap-3 border-b bg-amber-500/10 p-3"
          role="alert"
        >
          <p className="flex-1 text-sm">
            This canvas changed elsewhere. Your work is preserved on this device.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void session.client.canvas.get
                .query({ canvasId: session.record.id })
                .then((record) => session.acceptSaved(record))
                .catch((failure: unknown) =>
                  setError(
                    failure instanceof Error ? failure.message : 'Could not load the saved canvas.'
                  )
                )
            }
          >
            Load saved version
          </Button>
          <Button
            size="sm"
            onClick={() =>
              void session
                .preserveCopy()
                .then((copy) => router.push(`/canvas/${copy.id}`))
                .catch((failure: unknown) =>
                  setError(failure instanceof Error ? failure.message : 'Could not keep a copy.')
                )
            }
          >
            Keep mine as a copy
          </Button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden md:pb-3">
        {!isMobile && leftOpen ? (
          <aside aria-label="Canvas tools" className={`${FLOATING_PANEL} ms-3 overflow-hidden`}>
            <LeftPanel {...panelProps} />
          </aside>
        ) : null}
        <section aria-label="Board" className="relative min-w-0 flex-1">
          <CanvasBoard
            artboards={state.document.artboards}
            actions={actions}
            canEdit={canEdit}
            onDropFiles={(files, at) => void addScreenshots(files, at)}
            editor={
              <>
                <StoreGroupsLayer
                  session={session}
                  storeGroups={state.document.storeGroups}
                  canEdit={canEdit}
                />
                <PeerMarkers peers={presence.peers} artboards={state.document.artboards} />
                {active && editing ? (
                  <ActiveArtboardEditor artboard={active} ready={native.ready} error={native.error}>
                    <LayerSelection
                      artboard={active}
                      actions={layerActions}
                      canEdit={canEdit}
                      componentName={(id) =>
                        state.document.components.find((item) => item.id === id)?.name
                      }
                    />
                  </ActiveArtboardEditor>
                ) : null}
              </>
            }
          />
          {isMobile ? (
            <MobileBar onDialog={setDialog} onFit={() => actions.fitAll()} />
          ) : (
            <>
              <ZoomBar actions={actions} />
              <Minimap artboards={state.document.artboards} />
              {/* Beside the zoom bar, so neither covers the other or the board's labels. */}
              <AssistantSlot placement="end" />
            </>
          )}
        </section>
        {!isMobile && rightOpen ? (
          <aside aria-label="Properties" className={`${FLOATING_PANEL} me-3 overflow-y-auto`}>
            <RightPanel {...panelProps} />
          </aside>
        ) : null}
      </div>
      {active && native.ready && showTimeline ? (
        <div className="max-h-[40vh] shrink-0 overflow-auto border-t">
          <TimelineEditor />
        </div>
      ) : null}
      {isMobile ? (
        <>
          <Sheet
            open={dialog === 'mobile-artboards'}
            onOpenChange={(open) => setDialog(open ? 'mobile-artboards' : null)}
          >
            <SheetContent side="bottom" className="max-h-[70vh] overflow-y-auto">
              <SheetTitle className="px-4 pt-4">Artboards</SheetTitle>
              <LeftPanel {...panelProps} only="artboards" />
            </SheetContent>
          </Sheet>
          <Sheet
            open={dialog === 'mobile-properties'}
            onOpenChange={(open) => setDialog(open ? 'mobile-properties' : null)}
          >
            <SheetContent side="bottom" className="max-h-[70vh] overflow-y-auto">
              <SheetTitle className="px-4 pt-4">Properties</SheetTitle>
              <RightPanel {...panelProps} />
            </SheetContent>
          </Sheet>
        </>
      ) : null}
      {editingStore ? (
        <CanvasStoreEditor
          key={editingStore.group.id}
          session={session}
          item={editingStore}
          canEdit={canEdit}
          onClose={() => useCanvasUi.getState().editStore(null)}
        />
      ) : null}
      <CanvasDialogs
        dialog={dialog}
        onClose={() => setDialog(null)}
        session={session}
        canEdit={canEdit}
        flush={flush}
        actions={actions}
      />
    </main>
  )
}

function MobileBar({
  onDialog,
  onFit,
}: {
  onDialog: (dialog: CanvasDialog) => void
  onFit: () => void
}) {
  return (
    <div className="absolute inset-x-3 bottom-3 z-30 flex justify-center gap-2" data-board-control>
      <Button size="sm" variant="secondary" onClick={onFit}>
        Fit
      </Button>
      <Button size="sm" variant="secondary" onClick={() => onDialog('mobile-artboards')}>
        Artboards
      </Button>
      <Button size="sm" variant="secondary" onClick={() => onDialog('mobile-properties')}>
        Properties
      </Button>
      <Button size="sm" onClick={() => onDialog('export')}>
        Export
      </Button>
    </div>
  )
}
