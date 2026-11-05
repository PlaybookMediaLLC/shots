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
import { useWorkspaceSync, WorkspaceSaveStatus } from './workspace-sync'
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
import { TRPCClientError } from '@trpc/client'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import { useHydratedSession } from '@/lib/auth/client'
import { pullStoreProject, writeWorkspaceLink } from '@/lib/store-screenshots/workspace'
import { useTRPCClient } from '@/lib/trpc/react'

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
  const workspace = useWorkspaceSync(store)
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

  /** Delete this browser's copy; `everywhere` deletes the workspace copy first, and stops if that fails. */
  const deleteCurrent = async (everywhere: boolean) => {
    if (everywhere) {
      try {
        await workspace.deleteWorkspaceCopy()
      } catch (cause) {
        toast.error('Could not delete the workspace copy', {
          description: `${cause instanceof Error ? cause.message : 'Try again.'} Nothing was deleted.`,
        })
        return
      }
    }
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
            workspaceStatus={<WorkspaceSaveStatus sync={workspace} />}
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
          onDeleteCurrent={() => deleteCurrent(false)}
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
            saved={workspace.linked}
            onCancel={() => setConfirmDelete(false)}
            onConfirm={async (everywhere) => {
              setConfirmDelete(false)
              await deleteCurrent(everywhere)
            }}
          />
        ) : null}
      </ActiveSceneProvider>
    </StudioActionsProvider>
  )
}

/** Confirm a delete. A project saved to the workspace can go from this browser only, or everywhere. */
function DeleteProjectConfirm({ onCancel, onConfirm, saved }: { onCancel: () => void; onConfirm: (everywhere: boolean) => void; saved: boolean }): React.JSX.Element {
  const destructive = 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
  return (
    <AlertDialog open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this project?</AlertDialogTitle>
          <AlertDialogDescription>
            {saved
              ? 'It is also saved to your workspace. Delete it from this browser only, or everywhere: the workspace copy and its versions go too, so it leaves Library on every device. Other browsers keep a copy they already opened. This cannot be undone.'
              : 'Every slide, version, and image only this project uses is removed from this browser. This cannot be undone.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {saved ? (
            <>
              <AlertDialogAction className="border border-destructive bg-transparent text-destructive hover:bg-destructive/10" onClick={() => onConfirm(false)}>
                Delete from this browser
              </AlertDialogAction>
              <AlertDialogAction className={destructive} onClick={() => onConfirm(true)}>
                Delete everywhere
              </AlertDialogAction>
            </>
          ) : (
            <AlertDialogAction className={destructive} onClick={() => onConfirm(false)}>
              Delete project
            </AlertDialogAction>
          )}
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
              <div className="flex flex-wrap items-baseline gap-x-2">
                <h2 id="recent-projects" className="text-ui-lg font-semibold">
                  Your projects
                </h2>
                <p className="text-xs text-muted-foreground">
                  On this browser ·{' '}
                  <SidebarLink href="/library?type=store" className="underline underline-offset-2 hover:text-foreground">
                    Projects saved to your workspace are in Library
                  </SidebarLink>
                </p>
              </div>
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

/** The studio entry point, at `/create/store`; the open project is the path's last segment. */
export function StoreStudio({
  basePath,
  projectId,
}: {
  /** The studio's localized route. */
  basePath: string
  /** The project the route names. */
  projectId?: string
}): React.JSX.Element {
  const client = useTRPCClient()
  const { data: session, isPending: sessionPending } = useHydratedSession()
  const organizationId = session?.session.activeOrganizationId ?? null
  const [opened, setOpened] = React.useState<Opened | null>(null)
  const openedIdRef = React.useRef<string | null>(null)
  const [projects, setProjects] = React.useState<ProjectSummary[] | null>(null)
  const [pendingImport, setPendingImport] = React.useState<File[]>([])

  const setProjectUrl = React.useCallback(
    (id: string | null) => {
      const url = new URL(window.location.href)
      // An open that finishes after the person left the studio must not move their page.
      if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return
      url.pathname = id ? `${basePath}/${encodeURIComponent(id)}` : basePath
      window.history.replaceState(null, '', url)
    },
    [basePath]
  )

  /** Open a project. `quiet` when the studio reopened it on its own: a failure then shows the list, not an error. */
  const open = React.useCallback(async (id: string, quiet = false) => {
    try {
      const loaded = await loadProject(id)
      if (!loaded) throw new Error('That project no longer exists.')
      openedIdRef.current = id
      setOpened({ document: loaded.document, revision: loaded.document.revision })
      setProjectUrl(id)
    } catch (cause) {
      if (quiet) console.error(cause)
      else toast.error('Could not open the project', { description: cause instanceof Error ? cause.message : undefined })
      setProjects(await listProjects().catch(() => []))
    }
  }, [setProjectUrl])

  /** A project saved to the workspace from another browser: copy it here, then open it. */
  const openFromWorkspace = React.useCallback(async (id: string, workspaceId: string) => {
    try {
      const pulled = await pullStoreProject(client, id)
      await saveProject(pulled.document, 0, null)
      await writeWorkspaceLink(workspaceId, id, pulled.link)
      await open(id)
    } catch (cause) {
      const missing = cause instanceof TRPCClientError && cause.data?.code === 'NOT_FOUND'
      toast.error('Could not open the project', {
        description: missing ? 'It is not on this browser or in your workspace.' : cause instanceof Error ? cause.message : undefined,
      })
      setProjects(await listProjects().catch(() => []))
    }
  }, [client, open])

  const create = React.useCallback(async (kind: NewProjectKind) => {
    try {
      const document = kind === 'starter' ? createStarterDocument() : createScratchDocument()
      const saved = await saveProject(document, 0, null)
      openedIdRef.current = saved.id
      setOpened({ document: saved, revision: saved.revision })
      setProjectUrl(saved.id)
    } catch {
      toast.error('Could not create the project', { description: 'Free some browser storage and try again.' })
    }
  }, [setProjectUrl])

  React.useEffect(() => {
    // Which workspace a project might be saved in is known once the session is.
    if (sessionPending) return
    let active = true
    void (async () => {
      try {
        const imported = await importLegacyProject()
        if (imported) toast.success('Your screenshot set was upgraded', { description: 'It now lives in your project library with version history.' })
        const requested = projectId ?? null
        const last = requested ?? (await getMeta<string>('lastProjectId'))
        const list = await listProjects()
        if (!active) return
        const target = (last && list.find((project) => project.id === last)) || (imported ? list.find((project) => project.id === imported.id) : null)
        // Shown again with its project still open, the studio keeps the session it has.
        if (target && target.id === openedIdRef.current) setProjectUrl(target.id)
        else if (target) await open(target.id, !requested)
        else if (requested && organizationId) await openFromWorkspace(requested, organizationId)
        else {
          if (requested) toast.error('Could not open the project', { description: 'It is not on this browser.' })
          setProjects(list)
        }
      } catch (cause) {
        console.error(cause)
        if (active) setProjects([])
      }
    })()
    return () => {
      active = false
    }
  }, [basePath, open, openFromWorkspace, organizationId, projectId, sessionPending, setProjectUrl])

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
          openedIdRef.current = null
          setOpened(null)
          setProjects(await listProjects().catch(() => []))
          setProjectUrl(null)
        }}
      />
    )
  }
  if (!projects) return <StoreWorkspaceLoading variant="templates" />
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
