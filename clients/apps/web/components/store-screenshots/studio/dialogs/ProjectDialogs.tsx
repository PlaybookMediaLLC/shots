'use client'

import * as React from 'react'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { StoreDocument } from '@/lib/store-screenshots/document/schema'
import {
  createVersion,
  deleteProject,
  deleteVersion,
  duplicateProject,
  listProjects,
  listVersions,
  loadVersion,
  renameProject,
  type ProjectSummary,
  type VersionRecord,
} from '@/lib/store-screenshots/persistence/projects'
import { useEditor } from '../editor-store'
import type { NewProjectKind } from '../StoreStudio'
import type { DialogProps } from './BasicDialogs'
import { Input } from '@/components/ui/input'

/** The project library: search, open, rename, duplicate, delete, create. */
export function ProjectsDialog({
  open,
  onOpenChange,
  currentProjectId,
  onOpenProject,
  onNewProject,
  onDeleteCurrent,
}: DialogProps & { currentProjectId: string | null; onOpenProject: (id: string) => void; onNewProject: (kind: NewProjectKind) => void; onDeleteCurrent: () => Promise<void> }): React.JSX.Element {
  const [projects, setProjects] = React.useState<ProjectSummary[] | null>(null)
  const [query, setQuery] = React.useState('')
  const [confirmDelete, setConfirmDelete] = React.useState<ProjectSummary | null>(null)
  const [renaming, setRenaming] = React.useState<string | null>(null)

  const refresh = React.useCallback(() => {
    void listProjects().then(setProjects, () => setProjects([]))
  }, [])
  React.useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  const shown = (projects ?? []).filter((project) => project.name.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="grid-cols-[minmax(0,1fr)] max-h-[88vh] sm:max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Projects in this browser</DialogTitle>
            <DialogDescription>Projects are saved in this browser automatically. Images are stored once and shared between versions.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" aria-label="Search projects" className="h-9 min-w-48 flex-1 rounded-md border border-foreground/10 bg-foreground/[0.035] px-3 text-sm outline-none" />
            <Button variant="outline" onClick={() => onNewProject('scratch')}>
              New blank project
            </Button>
            <Button onClick={() => onNewProject('starter')}>New from sample set</Button>
          </div>
          {projects === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : shown.length === 0 ? (
            <p className="text-sm text-muted-foreground">{query ? 'No projects match.' : 'No saved projects yet.'}</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-3" aria-label="Saved projects">
              {shown.map((project) => (
                <li key={project.id} className="group flex flex-col overflow-hidden rounded-lg border border-foreground/10">
                  <Button variant="custom" size={null} type="button" onClick={() => onOpenProject(project.id)} className="flex aspect-[4/3] items-center justify-center bg-foreground/[0.04]" aria-label={`Open ${project.name}`}>
                    {project.thumbnail ? (
                      <img src={project.thumbnail} alt="" className="h-full object-contain" />
                    ) : (
                      <span className="text-xs text-muted-foreground">{project.slideCount} slides</span>
                    )}
                  </Button>
                  <div className="space-y-1 p-2">
                    {renaming === project.id ? (
                      <Input
                        autoFocus
                        defaultValue={project.name}
                        aria-label="Project name"
                        maxLength={120}
                        onBlur={async (event) => {
                          const name = event.target.value.trim()
                          setRenaming(null)
                          if (name && name !== project.name) {
                            await renameProject(project.id, name)
                            refresh()
                          }
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') event.currentTarget.blur()
                        }}
                        className="h-7 w-full rounded border border-foreground/20 px-1.5 text-xs"
                      />
                    ) : (
                      <p className="truncate text-ui-lg font-medium">
                        {project.name}
                        {project.id === currentProjectId ? <span className="ml-1 text-[10px] text-muted-foreground">(open)</span> : null}
                      </p>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      {project.slideCount} slides · {formatDistanceToNow(project.updatedAt, { addSuffix: true })}
                    </p>
                    <div className="flex gap-1 text-[11px]">
                      <Button variant="custom" size={null} type="button" className="rounded px-1.5 py-0.5 hover:bg-foreground/[0.06]" onClick={() => setRenaming(project.id)}>
                        Rename
                      </Button>
                      <Button variant="custom" size={null}
                        type="button"
                        className="rounded px-1.5 py-0.5 hover:bg-foreground/[0.06]"
                        onClick={async () => {
                          await duplicateProject(project.id, `${project.name} copy`)
                          refresh()
                        }}
                      >
                        Duplicate
                      </Button>
                      <Button variant="custom" size={null} type="button" className="rounded px-1.5 py-0.5 text-destructive hover:bg-destructive/10" onClick={() => setConfirmDelete(project)}>
                        Delete
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog open={Boolean(confirmDelete)} onOpenChange={(next) => !next && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{confirmDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>The project, its versions, and images no other project uses are removed from this browser. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                const target = confirmDelete
                setConfirmDelete(null)
                if (!target) return
                if (target.id === currentProjectId) {
                  await onDeleteCurrent()
                  return
                }
                await deleteProject(target.id)
                toast.success(`Deleted “${target.name}”`)
                refresh()
              }}
            >
              Delete project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** Named versions of the open project: save, restore, delete. */
export function VersionsDialog({
  open,
  onOpenChange,
  onRestore,
  thumbnail,
}: DialogProps & { onRestore: (document: StoreDocument) => void; thumbnail: () => Promise<string | null> }): React.JSX.Element {
  const document = useEditor((state) => state.document)
  const [versions, setVersions] = React.useState<Array<Omit<VersionRecord, 'document'>> | null>(null)
  const [name, setName] = React.useState('')
  const refresh = React.useCallback(() => {
    void listVersions(document.id).then(setVersions, () => setVersions([]))
  }, [document.id])
  React.useEffect(() => {
    if (open) refresh()
  }, [open, refresh])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] sm:max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>Save a named version before big changes. Restoring first saves the current design as a version, so nothing is lost.</DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={async (event) => {
            event.preventDefault()
            await createVersion(document, name || `Version ${new Date().toLocaleString()}`, await thumbnail())
            setName('')
            toast.success('Version saved')
            refresh()
          }}
        >
          <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Version name, e.g. “Before holiday campaign”" aria-label="Version name" maxLength={80} className="h-9 min-w-0 flex-1 rounded-md border border-foreground/10 bg-foreground/[0.035] px-3 text-sm outline-none" />
          <Button type="submit">Save version</Button>
        </form>
        {versions === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No named versions yet.</p>
        ) : (
          <ul className="space-y-2" aria-label="Versions">
            {versions.map((version) => (
              <li key={version.id} className="flex items-center gap-3 rounded-md border border-foreground/10 p-2">
                {version.thumbnail ? (
                  <img src={version.thumbnail} alt="" className="h-12 w-8 rounded object-cover" />
                ) : null}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-ui-lg font-medium">{version.name}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {version.slideCount} slides · {formatDistanceToNow(version.createdAt, { addSuffix: true })}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const loaded = await loadVersion(version.id)
                    if (!loaded) return
                    await createVersion(document, `Before restoring “${version.name}”`, await thumbnail())
                    onRestore({ ...loaded.document, id: document.id, revision: document.revision })
                    onOpenChange(false)
                    toast.success(`Restored “${version.name}”`)
                  }}
                >
                  Restore
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={async () => {
                    await deleteVersion(version.id)
                    refresh()
                  }}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
