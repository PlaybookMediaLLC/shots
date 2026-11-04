'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  RenderProvider,
  useRenderServices,
} from '@/components/store-screenshots/render/RenderProvider'
import { ActiveSceneProvider } from '@/components/store-screenshots/studio/active-scene'
import {
  StudioActionsProvider,
  type StudioActions,
  type StudioDialog,
} from '@/components/store-screenshots/studio/actions'
import { EditorCanvas } from '@/components/store-screenshots/studio/canvas/EditorCanvas'
import {
  createEditorStore,
  EditorStoreProvider,
} from '@/components/store-screenshots/studio/editor-store'
import { Filmstrip } from '@/components/store-screenshots/studio/Filmstrip'
import { Inspector } from '@/components/store-screenshots/studio/inspector/Inspector'
import { Sidebar } from '@/components/store-screenshots/studio/sidebar/Sidebar'
import { SlideThumbnail } from '@/components/store-screenshots/studio/SlideThumbnail'
import { useEditorShortcuts } from '@/components/store-screenshots/studio/shortcuts'
import { ImportDialog } from '@/components/store-screenshots/studio/dialogs/ImportDialog'
import { ExportDialog } from '@/components/store-screenshots/studio/dialogs/ExportDialog'
import { ChecksDialog } from '@/components/store-screenshots/studio/dialogs/ChecksDialog'
import { StorePreviewDialog } from '@/components/store-screenshots/studio/dialogs/StorePreviewDialog'
import {
  ApplyStyleDialog,
  ResetSlideDialog,
  ShortcutsDialog,
} from '@/components/store-screenshots/studio/dialogs/BasicDialogs'
import { StudioFeatureDialogs } from '@/components/store-screenshots/studio/dialogs/FeatureDialogs'
import { addStoreImages, type StoreImageTarget } from '@/components/creative-sets/store-images'
import type { CanvasSession } from '@/lib/canvas/session'
import {
  storeGroupRect,
  storeSlideRects,
  storeSlideSize,
  type CanvasStoreGroup,
} from '@/lib/canvas/store-groups'
import { useCanvasUi, useCanvasViewport } from '@/lib/canvas/ui-store'
import { intersects, rectToScreen, visibleWorldRect } from '@/lib/canvas/viewport'
import { loadStoreAsset, migrateStoreProject } from '@/lib/creative-sets/store-assets'
import { assertStoreAssetsReady } from '@/lib/creative-sets/store-delivery'
import { createScratchDocument } from '@/lib/store-screenshots/document/factory'
import {
  listProjects,
  loadProject,
  type ProjectSummary,
} from '@/lib/store-screenshots/persistence/projects'
import { STORE_TARGETS } from '@/lib/store-screenshots/targets'
import { useTRPCClient } from '@/lib/trpc/react'
import type { CanvasActions } from './use-canvas-actions'

/** Store slides drawn by the store renderer on the board, at their store size. */
function GroupSlides({ item, zoom }: { item: CanvasStoreGroup; zoom: number }) {
  const client = useTRPCClient()
  const group = item.group
  const loadAsset = useCallback((id: string) => loadStoreAsset(client, group, id), [client, group])
  const size = storeSlideSize(item)
  const rects = storeSlideRects(item)
  return (
    <RenderProvider document={group.document} loadAsset={loadAsset}>
      {group.document.slides.map((slide, index) => (
        <div
          key={slide.id}
          className="absolute bg-white shadow-sm"
          style={{
            left: (rects[index]!.x - item.x) * zoom,
            top: 0,
            width: size.width * zoom,
            height: size.height * zoom,
          }}
        >
          <SlideThumbnail
            document={group.document}
            index={index}
            size={size}
            targetId={item.targetId}
            locale={group.document.localization.sourceLocale}
            height={size.height * zoom}
          />
        </div>
      ))}
    </RenderProvider>
  )
}

/**
 * Every store group in view, at its place on the plane. A group moves by
 * its label, opens with a double-click, and is otherwise inert so the board
 * keeps panning and zooming over it.
 */
export function StoreGroupsLayer({
  session,
  storeGroups,
  canEdit,
}: {
  session: CanvasSession
  storeGroups: readonly CanvasStoreGroup[]
  canEdit: boolean
}) {
  const viewport = useCanvasViewport((state) => state.viewport)
  const screen = useCanvasViewport((state) => state.screen)
  const settledZoom = useCanvasViewport((state) => state.settledZoom)
  const selected = useCanvasUi((state) => state.storeSelection)
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null)
  const view = visibleWorldRect(viewport, screen)
  return (
    <>
      {storeGroups.map((item) => {
        const bounds = storeGroupRect(item)
        if (!intersects(bounds, view)) return null
        const offset = drag?.id === item.group.id ? drag : { dx: 0, dy: 0 }
        const rect = rectToScreen(viewport, bounds)
        const id = item.group.id
        const start = (event: React.PointerEvent) => {
          if (event.button !== 0) return
          event.stopPropagation()
          useCanvasUi.getState().selectStore(id)
          if (!canEdit) return
          const origin = { x: event.clientX, y: event.clientY }
          const zoom = viewport.zoom
          const move = (next: PointerEvent) =>
            setDrag({
              id,
              dx: (next.clientX - origin.x) / zoom,
              dy: (next.clientY - origin.y) / zoom,
            })
          const end = (next: PointerEvent) => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', end)
            setDrag(null)
            const dx = (next.clientX - origin.x) / zoom
            const dy = (next.clientY - origin.y) / zoom
            if (Math.hypot(dx, dy) * zoom < 3) return
            try {
              session.command({
                type: 'move-store-group',
                id,
                x: Math.round(item.x + dx),
                y: Math.round(item.y + dy),
              })
            } catch (error) {
              toast.error(
                error instanceof Error ? error.message : 'The store group could not move.'
              )
            }
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', end)
        }
        return (
          <div
            key={id}
            data-board-control
            data-store-group-id={id}
            aria-label={`${item.group.name}, ${item.group.document.slides.length} store screenshots`}
            className="absolute"
            style={{
              left: rect.x + offset.dx * viewport.zoom,
              top: rect.y + offset.dy * viewport.zoom,
              width: rect.width,
              height: rect.height,
            }}
            onPointerDown={start}
            onDoubleClick={() => useCanvasUi.getState().editStore(id)}
          >
            <Button
              variant="custom"
              size={null}
              type="button"
              data-store-group-label
              className="absolute -top-6 left-0 flex max-w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] font-medium"
              style={{
                background: selected === id ? '#2563eb' : 'transparent',
                color: selected === id ? '#fff' : undefined,
              }}
              title="Drag to move · double-click to edit the screenshots"
            >
              {item.group.name}
              <span className="opacity-70">
                · {STORE_TARGETS.find((target) => target.id === item.targetId)?.shortName}
              </span>
            </Button>
            <div
              className="absolute inset-0"
              style={{
                transform: `scale(${viewport.zoom / settledZoom})`,
                transformOrigin: '0 0',
                outline:
                  selected === id
                    ? `${2 * (settledZoom / viewport.zoom)}px solid #2563eb`
                    : undefined,
                outlineOffset: 4,
              }}
            >
              <GroupSlides item={item} zoom={settledZoom} />
            </div>
          </div>
        )
      })}
    </>
  )
}

/** Properties of the selected store group. */
export function StoreGroupPanel({
  session,
  item,
  canEdit,
}: {
  session: CanvasSession
  item: CanvasStoreGroup
  canEdit: boolean
}) {
  const [name, setName] = useState(item.group.name)
  const id = item.group.id
  const run = (command: Parameters<CanvasSession['command']>[0]) => {
    try {
      session.command(command)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That change could not be made.')
    }
  }
  return (
    <div data-testid="store-group-panel">
      <section className="space-y-2 border-b px-4 py-4">
        <h2 className="text-ui-lg font-medium">App Store screenshots</h2>
        <p className="text-[11px] text-muted-foreground">
          {item.group.document.slides.length} slides ·{' '}
          {item.group.document.localization.locales.length || 1} languages · drawn and exported by
          the store renderer
        </p>
        <form
          className="flex gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim() && name.trim() !== item.group.name)
              run({ type: 'rename-store-group', id, name: name.trim() })
          }}
        >
          <Input
            aria-label="Store group name"
            value={name}
            maxLength={120}
            disabled={!canEdit}
            onChange={(event) => setName(event.target.value)}
            className="h-8"
          />
          <Button size="sm" type="submit" variant="outline" disabled={!canEdit}>
            Rename
          </Button>
        </form>
        <Label className="grid gap-1 text-xs text-muted-foreground">
          Device size on the canvas
          <Select
            value={item.targetId}
            disabled={!canEdit}
            onValueChange={(targetId) => run({ type: 'set-store-target', id, targetId })}
          >
            <SelectTrigger aria-label="Store device size" className="h-8 w-full text-foreground">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STORE_TARGETS.map((target) => (
                <SelectItem key={target.id} value={target.id}>
                  {target.store === 'app-store' ? 'App Store' : 'Google Play'} · {target.shortName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Label>
        <div className="grid grid-cols-2 gap-1">
          <Button size="sm" onClick={() => useCanvasUi.getState().editStore(id)}>
            {canEdit ? 'Edit screenshots' : 'Open screenshots'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-destructive"
            disabled={!canEdit}
            onClick={() => {
              run({ type: 'remove-store-group', id })
              useCanvasUi.getState().selectStore(null)
            }}
          >
            Delete
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Export every required store size and language from the screenshot editor.
        </p>
      </section>
    </div>
  )
}

/** Copy a store project from this browser onto the canvas, or start a new store group. */
export function AddStoreGroupDialog({
  session,
  actions,
  onClose,
}: {
  session: CanvasSession
  actions: CanvasActions
  onClose: () => void
}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const verified = useRef(new Map<string, string>())
  useEffect(() => {
    let active = true
    void listProjects()
      .then((found) => {
        if (active) setProjects(found)
      })
      .catch((failure: Error) => {
        if (active) setError(failure.message)
      })
    return () => {
      active = false
    }
  }, [])
  async function add(projectId?: string) {
    setBusy(true)
    setError(null)
    try {
      const document = projectId
        ? (await loadProject(projectId))?.document
        : createScratchDocument()
      if (!document) throw new Error('This local store project is no longer available.')
      const group = await migrateStoreProject(session.client, document, verified.current)
      if (!projectId) {
        delete group.origin
        group.name = 'App Store screenshots'
      }
      if (!actions.addStoreGroup(group)) return
      if (!(await session.save()))
        throw new Error(
          'The store group is kept on this device. Resolve the save problem shown above.'
        )
      onClose()
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'The store project could not be copied.'
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogTitle>Add App Store screenshots</DialogTitle>
        <DialogDescription>
          Start a new store screenshot group, or copy a project from the screenshots studio in this
          browser. Every image and font is uploaded to the workspace and verified; the original
          stays where it is.
        </DialogDescription>
        <Button disabled={busy} onClick={() => void add()}>
          New store screenshot group
        </Button>
        {projects.length ? (
          <ul
            aria-label="Store projects in this browser"
            className="max-h-72 space-y-1 overflow-auto"
          >
            {projects.map((project) => (
              <li key={project.id}>
                <Button
                  className="w-full justify-start"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void add(project.id)}
                >
                  {project.name} · {project.slideCount} slides
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No store projects in this browser yet.</p>
        )}
        {busy ? <p role="status">Copying and verifying workspace assets…</p> : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/** Export gate: every asset and font of the group must resolve before files are written. */
function StoreExport({ onClose }: { onClose: () => void }) {
  const { resolveAsset } = useRenderServices()
  return (
    <ExportDialog
      open
      strict
      onOpenChange={(open) => !open && onClose()}
      beforeExport={(document) => assertStoreAssetsReady(document, resolveAsset)}
    />
  )
}

/**
 * The store screenshot editor for one group, full screen over the canvas.
 * It is the screenshots studio's own editor; each finished edit is one
 * canvas command, saved with the canvas.
 */
export function CanvasStoreEditor({
  session,
  item,
  canEdit,
  onClose,
}: {
  session: CanvasSession
  item: CanvasStoreGroup
  canEdit: boolean
  onClose: () => void
}) {
  const id = item.group.id
  const [store] = useState(() => {
    const created = createEditorStore(item.group.document)
    if (!canEdit)
      created.setState({
        dispatch: () => false,
        dispatchMany: () => false,
        replaceDocument: () => undefined,
      })
    return created
  })
  const document = useStore(store, (state) => state.document)
  const [dialog, setDialog] = useState<StudioDialog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const target = useRef<StoreImageTarget>({ kind: 'image' })
  const baseline = useRef(item.group.document)
  const flush = useCallback(() => {
    if (!canEdit) return
    const next = store.getState().document
    if (next === baseline.current) return
    try {
      session.command({ type: 'edit-store-group', id, document: next })
      baseline.current = next
      setError(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The store edit could not be saved.')
    }
  }, [canEdit, id, session, store])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let pointing = false
    const start = () => {
      flush()
      pointing = true
    }
    const end = () => {
      pointing = false
      clearTimeout(timer)
      timer = setTimeout(flush, 0)
    }
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.document === previous.document) return
      clearTimeout(timer)
      if (!pointing) timer = setTimeout(flush, 500)
    })
    window.addEventListener('pointerdown', start, true)
    window.addEventListener('pointerup', end)
    window.addEventListener('focusout', end)
    return () => {
      flush()
      clearTimeout(timer)
      unsubscribe()
      window.removeEventListener('pointerdown', start, true)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('focusout', end)
    }
  }, [flush, store])
  const importFiles = async (
    files: File[],
    device: { slideId: string; layerId: string } | null
  ) => {
    if (!canEdit) return
    try {
      await addStoreImages(store, files, device ? { kind: 'device', ...device } : target.current)
      flush()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Image import failed.')
    }
  }
  const actions: StudioActions = {
    chooseScreenshot(device) {
      if (device) {
        target.current = { kind: 'device', ...device }
        input.current?.click()
      } else setDialog('import')
    },
    importFiles: (files, device) => void importFiles(files, device),
    chooseImageLayer() {
      target.current = { kind: 'image' }
      input.current?.click()
    },
    chooseBackgroundImage() {
      target.current = { kind: 'background' }
      input.current?.click()
    },
    openDialog(next) {
      flush()
      setDialog(next)
    },
  }
  useEditorShortcuts(store, actions, () => {
    flush()
    void session.save()
  })
  const loadAsset = useCallback(
    (assetId: string) =>
      loadStoreAsset(
        session.client,
        { ...item.group, document: store.getState().document },
        assetId
      ),
    [item.group, session, store]
  )
  const close = (open: boolean) => {
    if (!open) {
      flush()
      setDialog(null)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !dialog) {
          flush()
          onClose()
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[92vh] max-w-[96vw] flex-col gap-0 p-0 sm:max-w-[96vw]"
        data-testid="canvas-store-editor"
      >
        <EditorStoreProvider value={store}>
          <RenderProvider document={document} loadAsset={loadAsset}>
            <StudioActionsProvider value={actions}>
              <ActiveSceneProvider>
                <div className="flex items-center gap-2 border-b px-3 py-2">
                  <DialogTitle className="mr-auto text-ui-lg font-medium">
                    {item.group.name} · App Store screenshots
                  </DialogTitle>
                  <DialogDescription className="sr-only">
                    The screenshots studio editor for this store group. Edits save with the canvas.
                  </DialogDescription>
                  <Button size="sm" variant="outline" onClick={() => actions.openDialog('preview')}>
                    Preview
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => actions.openDialog('export')}>
                    Export store sizes
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      flush()
                      onClose()
                    }}
                  >
                    Done
                  </Button>
                </div>
                {error ? (
                  <p role="alert" className="p-2 text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
                <div className="flex min-h-0 flex-1">
                  {canEdit ? <Sidebar /> : null}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="flex min-h-0 flex-1" inert={!canEdit}>
                      <EditorCanvas onFiles={actions.importFiles} />
                    </div>
                    <Filmstrip />
                  </div>
                  {canEdit ? <Inspector /> : null}
                </div>
                <Input
                  ref={input}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (file)
                      void importFiles(
                        [file],
                        target.current.kind === 'device' ? target.current : null
                      )
                  }}
                />
                {canEdit && dialog === 'import' ? (
                  <ImportDialog open onOpenChange={close} initialFiles={[]} />
                ) : null}
                {dialog === 'export' ? <StoreExport onClose={() => close(false)} /> : null}
                {dialog === 'preview' ? <StorePreviewDialog open onOpenChange={close} /> : null}
                {dialog === 'checks' ? (
                  <ChecksDialog open onOpenChange={close} onExport={() => setDialog('export')} />
                ) : null}
                {dialog === 'shortcuts' ? <ShortcutsDialog open onOpenChange={close} /> : null}
                {canEdit && dialog === 'applyStyle' ? (
                  <ApplyStyleDialog open onOpenChange={close} />
                ) : null}
                {canEdit && dialog === 'resetSlide' ? (
                  <ResetSlideDialog open onOpenChange={close} />
                ) : null}
                {canEdit ? (
                  <StudioFeatureDialogs
                    dialog={dialog}
                    onOpenChange={close}
                    onCreateProject={(next) => {
                      store.getState().replaceDocument(next)
                      flush()
                      setDialog(null)
                    }}
                  />
                ) : null}
              </ActiveSceneProvider>
            </StudioActionsProvider>
          </RenderProvider>
        </EditorStoreProvider>
      </DialogContent>
    </Dialog>
  )
}
