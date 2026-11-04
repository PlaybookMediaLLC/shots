'use client'

import * as React from 'react'
import { useStore } from 'zustand'
import { toast } from 'sonner'
import { z } from 'zod'
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
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { TooltipProvider } from '@/components/ui/tooltip'
import { MobileBanner } from '@/components/editor/MobileBanner'
import { countIssues, runChecks } from '@/lib/store-screenshots/compliance'
import { loadExportSettings } from '@/lib/store-screenshots/export/settings'
import { createImageLayer } from '@/lib/store-screenshots/document/elements'
import { createScratchDocument, createStarterDocument } from '@/lib/store-screenshots/document/factory'
import type { StoreDocument } from '@/lib/store-screenshots/document/schema'
import { evaluateSlide } from '@/lib/store-screenshots/engine/scene'
import { importLegacyProject } from '@/lib/store-screenshots/persistence/legacy'
import { ingestImageFile } from '@/lib/store-screenshots/persistence/ingest'
import { getMeta, listProjects, loadProject, saveProject, type ProjectSummary } from '@/lib/store-screenshots/persistence/projects'
import { DEFAULT_TARGET_ID, getStoreTargetOrDefault, targetPixelSize } from '@/lib/store-screenshots/targets'
import { RenderProvider, useRenderServices } from '../render/RenderProvider'
import { StoreWorkspaceLoading } from '../StoreWorkspaceLoading'
import { ActiveSceneProvider } from './active-scene'
import { StudioActionsProvider, type StudioActions, type StudioDialog } from './actions'
import { useAutosave } from './autosave'
import { EditorCanvas } from './canvas/EditorCanvas'
import { ApplyStyleDialog, ResetSlideDialog, ShortcutsDialog } from './dialogs/BasicDialogs'
import { ChecksDialog } from './dialogs/ChecksDialog'
import { ExportDialog } from './dialogs/ExportDialog'
import { ImportDialog } from './dialogs/ImportDialog'
import { ProjectsDialog, VersionsDialog } from './dialogs/ProjectDialogs'
import { StorePreviewDialog } from './dialogs/StorePreviewDialog'
import { StudioFeatureDialogs } from './dialogs/FeatureDialogs'
import { createEditorStore, EditorStoreProvider, type EditorState } from './editor-store'
import { Filmstrip } from './Filmstrip'
import { Inspector } from './inspector/Inspector'
import { useEditorShortcuts } from './shortcuts'
import { Sidebar } from './sidebar/Sidebar'
import { SlideThumbnail } from './SlideThumbnail'
import { StudioHeader } from './StudioHeader'
import type { StoreApi } from 'zustand/vanilla'
import { Input } from '@/components/ui/input'

/**
 * The store screenshot studio. Opens the last project (or migrates the old
 * single working session the first time), offers a start screen when there
 * is nothing to open, and hosts the editor: tools on the left, the canvas
 * and filmstrip in the middle, the docked inspector on the right.
 */

/** How a new project starts. */
export const newProjectKindSchema = z.enum(['starter', 'scratch'])

/** New project kind. */
export type NewProjectKind = z.infer<typeof newProjectKindSchema>

type Opened = { document: StoreDocument; revision: number }

function RenderBridge({ store, children }: { store: StoreApi<EditorState>; children: React.ReactNode }): React.JSX.Element {
  const assets = useStore(store, (state) => state.document.assets)
  const fonts = useStore(store, (state) => state.document.fonts)
  const document = React.useMemo(() => ({ assets, fonts }), [assets, fonts])
  return <RenderProvider document={document}>{children}</RenderProvider>
}

function useHeaderIssues(store: StoreApi<EditorState>, dialog: StudioDialog | null) {
  const document = useStore(store, (state) => state.document)
  const { measurer, fontsVersion } = useRenderServices()
  const [counts, setCounts] = React.useState({ requirements: 0, recommendations: 0 })
  React.useEffect(() => {
    const timer = setTimeout(() => {
      const selection = loadExportSettings(document)
      void fontsVersion
      const issues = runChecks(document, selection, (index, target, sizeIndex, orientation, checkLocale) =>
        evaluateSlide(document, index, { size: targetPixelSize(target, sizeIndex, orientation), targetId: target.id, locale: checkLocale, measurer })
      )
      setCounts(countIssues(issues))
    }, 400)
    return () => clearTimeout(timer)
  }, [document, dialog, measurer, fontsVersion])
  return counts
}

function EditorLayout({
  store,
  initialImport,
  onOpenProject,
  onNewProject,
  onProjectDeleted,
}: {
  store: StoreApi<EditorState>
  initialImport: File[]
  onOpenProject: (id: string) => void
  onNewProject: (kind: NewProjectKind) => void
  onProjectDeleted: () => void
}): React.JSX.Element {
  const autosave = useAutosave(store, store.getState().document.revision)
  const [dialog, setDialog] = React.useState<StudioDialog | null>(initialImport.length ? 'import' : null)
  const [importFilesQueue, setImportFilesQueue] = React.useState<File[]>(initialImport)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const screenshotInputRef = React.useRef<HTMLInputElement>(null)
  const imageInputRef = React.useRef<HTMLInputElement>(null)
  const backgroundInputRef = React.useRef<HTMLInputElement>(null)
  const deviceTargetRef = React.useRef<{ slideId: string; layerId: string } | null>(null)
  const issueCount = useHeaderIssues(store, dialog)
  const documentId = useStore(store, (state) => state.document.id)
  const isMobile = useIsMobile()
  const [mobilePanel, setMobilePanel] = React.useState<'tools' | 'inspector'>('tools')
  const [mobilePanelOpen, setMobilePanelOpen] = React.useState(false)

  const ingestOne = React.useCallback(async (file: File) => {
    try {
      return await ingestImageFile(file)
    } catch (cause) {
      toast.error('Could not use that image', { description: cause instanceof Error ? cause.message : undefined })
      return null
    }
  }, [])

  const actions = React.useMemo<StudioActions>(
    () => ({
      chooseScreenshot(device) {
        deviceTargetRef.current = device
        if (device) screenshotInputRef.current?.click()
        else setDialog('import')
      },
      importFiles(files, device) {
        if (device) {
          void ingestOne(files[0]).then((asset) => {
            if (!asset) return
            store.getState().dispatchMany(
              [
                { type: 'assets.add', assets: [asset] },
                { type: 'layers.patch', owner: { kind: 'slide', id: device.slideId }, layerIds: [device.layerId], patch: { assetId: asset.id, image: { mode: 'fill', scale: 1, offsetX: 0, offsetY: 0 } } },
              ],
              'Replace screenshot'
            )
          })
          return
        }
        setImportFilesQueue(files)
        setDialog('import')
      },
      chooseImageLayer() {
        imageInputRef.current?.click()
      },
      chooseBackgroundImage() {
        backgroundInputRef.current?.click()
      },
      openDialog(next) {
        setDialog(next)
      },
    }),
    [ingestOne, store]
  )

  useEditorShortcuts(store, actions, () => void autosave.saveNow().then((saved) => { if (saved) toast.success('Saved') }))

  const deleteCurrent = async () => {
    if (await autosave.deleteCurrent()) onProjectDeleted()
  }

  const close = (open: boolean) => {
    if (!open) {
      setDialog(null)
      setImportFilesQueue([])
    }
  }

  return (
    <StudioActionsProvider value={actions}>
      <ActiveSceneProvider>
        <div className="flex h-[var(--editor-height,100dvh)] flex-col overflow-hidden bg-background">
          <MobileBanner />
          <StudioHeader
            issueCount={issueCount}
            onKeepMine={() => void autosave.keepMine()}
            onLoadTheirs={() => void autosave.loadTheirs()}
            onSaveVersion={() => setDialog('versions')}
            onStartOver={() => setConfirmDelete(true)}
          />
          {isMobile ? (
            <div className="flex shrink-0 gap-2 border-b border-foreground/10 px-3 py-1.5">
              <Button size="sm" variant="outline" onClick={() => { setMobilePanel('tools'); setMobilePanelOpen(true) }}>Tools</Button>
              <Button size="sm" variant="outline" onClick={() => { setMobilePanel('inspector'); setMobilePanelOpen(true) }}>Inspector</Button>
            </div>
          ) : null}
          <div className="flex min-h-0 flex-1">
            {!isMobile ? <Sidebar /> : null}
            <main className="flex min-w-0 flex-1 flex-col" aria-label="Slide editor">
              <EditorCanvas onFiles={actions.importFiles} />
              <Filmstrip />
            </main>
            {!isMobile ? <Inspector /> : null}
          </div>
        </div>
        {isMobile ? (
          <Sheet open={mobilePanelOpen} onOpenChange={setMobilePanelOpen}>
            <SheetContent side={mobilePanel === 'inspector' ? 'right' : 'left'} className="w-[min(100%,360px)] gap-0 p-0">
              <SheetTitle className="px-4 py-4 text-sm">{mobilePanel === 'inspector' ? 'Inspector' : 'Tools'}</SheetTitle>
              <div className="min-h-0 flex-1 [&>aside]:w-full">
                {mobilePanel === 'inspector' ? <Inspector /> : <Sidebar />}
              </div>
            </SheetContent>
          </Sheet>
        ) : null}
        <Input
          ref={screenshotInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) actions.importFiles([file], deviceTargetRef.current)
            event.currentTarget.value = ''
          }}
        />
        <Input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.currentTarget.value = ''
            if (!file) return
            void ingestOne(file).then((asset) => {
              if (!asset) return
              const state = store.getState()
              const layer = createImageLayer(asset.id, asset.name)
              const owner = { kind: 'slide' as const, id: state.activeSlideId }
              state.dispatchMany([{ type: 'assets.add', assets: [asset] }, { type: 'layers.add', owner, layers: [layer] }], 'Add image')
              state.selectLayers(owner, [layer.id])
            })
          }}
        />
        <Input
          ref={backgroundInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.currentTarget.value = ''
            if (!file) return
            void ingestOne(file).then((asset) => {
              if (!asset) return
              const state = store.getState()
              state.dispatchMany(
                [
                  { type: 'assets.add', assets: [asset] },
                  { type: 'slides.patch', slideIds: state.selectedSlideIds, patch: { background: { kind: 'image', assetId: asset.id, fit: 'cover', focusX: 50, focusY: 50, color: asset.colorGrid[13] ?? '#000000' } } },
                ],
                'Background image'
              )
            })
          }}
        />
        <ShortcutsDialog open={dialog === 'shortcuts'} onOpenChange={close} />
        <ResetSlideDialog open={dialog === 'resetSlide'} onOpenChange={close} />
        {dialog === 'applyStyle' ? <ApplyStyleDialog open onOpenChange={close} /> : null}
        {dialog === 'import' ? <ImportDialog open onOpenChange={close} initialFiles={importFilesQueue} /> : null}
        {dialog === 'checks' ? <ChecksDialog open onOpenChange={close} onExport={() => setDialog('export')} /> : null}
        {dialog === 'export' ? <ExportDialog open onOpenChange={close} /> : null}
        {dialog === 'preview' ? <StorePreviewDialog open onOpenChange={close} /> : null}
        <ProjectsDialog
          open={dialog === 'projects'}
          onOpenChange={close}
          currentProjectId={documentId}
          onOpenProject={(id) => {
            void autosave.saveNow().then((saved) => {
              if (!saved) return
              setDialog(null)
              onOpenProject(id)
            })
          }}
          onNewProject={(kind) => {
            void autosave.saveNow().then((saved) => {
              if (!saved) return
              setDialog(null)
              onNewProject(kind)
            })
          }}
          onDeleteCurrent={deleteCurrent}
        />
        {dialog === 'versions' ? (
          <VersionsDialog
            open
            onOpenChange={close}
            thumbnail={async () => null}
            onRestore={(document) => store.getState().replaceDocument(document, { undoLabel: 'Restore version' })}
          />
        ) : null}
        <StudioFeatureDialogs
          dialog={dialog}
          onOpenChange={close}
          onCreateProject={(document) => {
            void autosave
              .saveNow()
              .then(async (saved) => {
                if (!saved) return
                const created = await saveProject(document, 0, null)
                setDialog(null)
                onOpenProject(created.id)
              })
              .catch(() => toast.error('Could not create the project. Your current project is still open.'))
          }}
        />
        {confirmDelete ? (
          <DeleteProjectConfirm
            onCancel={() => setConfirmDelete(false)}
            onConfirm={async () => {
              setConfirmDelete(false)
              await deleteCurrent()
            }}
          />
        ) : null}
      </ActiveSceneProvider>
    </StudioActionsProvider>
  )
}

function DeleteProjectConfirm({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }): React.JSX.Element {
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this project?</AlertDialogTitle>
          <AlertDialogDescription>Every slide, version, and image only this project uses is removed from this browser. This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={onConfirm}>
            Delete project
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function StudioEditor({ opened, ...handlers }: { opened: Opened } & Omit<Parameters<typeof EditorLayout>[0], 'store'>): React.JSX.Element {
  const [store] = React.useState(() => {
    const created = createEditorStore({ ...opened.document, revision: opened.revision })
    created.getState().setTarget(DEFAULT_TARGET_ID)
    return created
  })
  return (
    <EditorStoreProvider value={store}>
      <RenderBridge store={store}>
        <TooltipProvider delayDuration={400}>
          <EditorLayout store={store} {...handlers} />
        </TooltipProvider>
      </RenderBridge>
    </EditorStoreProvider>
  )
}

function StartScreen({ projects, onStart, onOpen, onImport }: { projects: ProjectSummary[]; onStart: (kind: NewProjectKind) => void; onOpen: (id: string) => void; onImport: (files: File[]) => void }): React.JSX.Element {
  const [starter] = React.useState(() => createStarterDocument())
  const size = targetPixelSize(getStoreTargetOrDefault(DEFAULT_TARGET_ID))
  const inputRef = React.useRef<HTMLInputElement>(null)
  return (
    <RenderProvider document={starter}>
      <div className="flex min-h-[var(--editor-height,100dvh)] flex-col bg-background">
        <MobileBanner />
        <div className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
          <h1 className="text-2xl font-semibold tracking-tight">App Store and Google Play screenshots</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Design one set and export every store size, language, and format. Start from the sample set, a blank slide, or your own screenshots.
          </p>
          <div className="mt-6 flex gap-3 overflow-x-auto pb-2" aria-label="Sample set preview">
            {starter.slides.map((slide, index) => (
              <SlideThumbnail key={slide.id} document={starter} index={index} size={size} targetId={DEFAULT_TARGET_ID} locale="en-US" width={110} className="shrink-0 overflow-hidden rounded-md shadow-md ring-1 ring-foreground/10" />
            ))}
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button onClick={() => onStart('starter')}>Use the sample set</Button>
            <Button variant="outline" onClick={() => onStart('scratch')}>
              Start from scratch
            </Button>
            <Button variant="outline" onClick={() => inputRef.current?.click()}>
              Import screenshots…
            </Button>
            <Input
              ref={inputRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                event.currentTarget.value = ''
                if (files.length) onImport(files)
              }}
            />
          </div>
          {projects.length ? (
            <section className="mt-10" aria-labelledby="recent-projects">
              <h2 id="recent-projects" className="text-ui-lg font-semibold">
                Your projects
              </h2>
              <ul className="mt-3 grid gap-3 sm:grid-cols-4">
                {projects.map((project) => (
                  <li key={project.id}>
                    <Button variant="custom" size={null} type="button" onClick={() => onOpen(project.id)} className="w-full rounded-lg border border-foreground/10 p-3 text-left hover:bg-foreground/[0.03]">
                      <span className="block truncate text-ui-lg font-medium">{project.name}</span>
                      <span className="text-[11px] text-muted-foreground">{project.slideCount} slides</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </RenderProvider>
  )
}

/** The studio entry point. */
export function StoreStudio({ initialHasSavedProject = false, projectParam = 'project' }: { initialHasSavedProject?: boolean; projectParam?: 'project' | 'storeProject' }): React.JSX.Element {
  const [opened, setOpened] = React.useState<Opened | null>(null)
  const [projects, setProjects] = React.useState<ProjectSummary[] | null>(null)
  const [pendingImport, setPendingImport] = React.useState<File[]>([])

  const open = React.useCallback(async (id: string) => {
    try {
      const loaded = await loadProject(id)
      if (!loaded) throw new Error('That project no longer exists.')
      setOpened({ document: loaded.document, revision: loaded.document.revision })
      const url = new URL(window.location.href)
      url.searchParams.set(projectParam, id)
      window.history.replaceState(null, '', url)
    } catch (cause) {
      toast.error('Could not open the project', { description: cause instanceof Error ? cause.message : undefined })
      setProjects(await listProjects().catch(() => []))
    }
  }, [projectParam])

  const create = React.useCallback(async (kind: NewProjectKind) => {
    try {
      const document = kind === 'starter' ? createStarterDocument() : createScratchDocument()
      const saved = await saveProject(document, 0, null)
      setOpened({ document: saved, revision: saved.revision })
      const url = new URL(window.location.href)
      url.searchParams.set(projectParam, saved.id)
      window.history.replaceState(null, '', url)
    } catch {
      toast.error('Could not create the project', { description: 'Free some browser storage and try again.' })
    }
  }, [projectParam])

  React.useEffect(() => {
    let active = true
    void (async () => {
      try {
        const imported = await importLegacyProject()
        if (imported) toast.success('Your screenshot set was upgraded', { description: 'It now lives in your project library with version history.' })
        const requested = new URL(window.location.href).searchParams.get(projectParam)
        const last = requested ?? (await getMeta<string>('lastProjectId'))
        const list = await listProjects()
        if (!active) return
        const target = (last && list.find((project) => project.id === last)) || (imported ? list.find((project) => project.id === imported.id) : null)
        if (target) await open(target.id)
        else setProjects(list)
      } catch (cause) {
        console.error(cause)
        if (active) setProjects([])
      }
    })()
    return () => {
      active = false
    }
  }, [open, projectParam])

  if (opened) {
    return (
      <StudioEditor
        key={opened.document.id}
        opened={opened}
        initialImport={pendingImport}
        onOpenProject={(id) => { setPendingImport([]); void open(id) }}
        onNewProject={(kind) => { setPendingImport([]); void create(kind) }}
        onProjectDeleted={async () => {
          setPendingImport([])
          setOpened(null)
          setProjects(await listProjects().catch(() => []))
          const url = new URL(window.location.href)
          url.searchParams.delete(projectParam)
          window.history.replaceState(null, '', url)
        }}
      />
    )
  }
  if (!projects) return <StoreWorkspaceLoading variant={initialHasSavedProject ? 'editor' : 'templates'} />
  return (
    <StartScreen
      projects={projects}
      onStart={(kind) => { setPendingImport([]); void create(kind) }}
      onOpen={(id) => { setPendingImport([]); void open(id) }}
      onImport={(files) => {
        setPendingImport(files)
        void create('scratch')
      }}
    />
  )
}
