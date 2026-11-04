'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { DocumentPreview } from '@/components/design/DocumentPreview'
import { Pill } from '@/components/platform-ui'
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
import type { DesignDocument } from '@/lib/design/document'
import { exportDesignDocument } from '@/lib/design/export'
import { changedSections, sectionLabel } from '@/lib/projects/compare'
import type { ProjectVersionKind } from '@/lib/projects/schema'
import { currentProjectDocument, restoreProjectVersion } from '@/lib/projects/session'
import { useTRPCClient } from '@/lib/trpc/react'
import { cn } from '@/lib/utils'
import { ProjectPreview } from './ProjectPreview'

const KIND_LABELS: Record<ProjectVersionKind, string> = {
  autosave: 'Autosave',
  duplicate: 'Duplicated',
  named: 'Named version',
  restore: 'Restored',
}

type Version = {
  createdAt: Date
  createdByName: string | null
  id: string
  kind: ProjectVersionKind
  name: string | null
  revision: number
}

type Loaded<T> = { error: string | null; value: T | null }

function versionTitle(version: Version): string {
  return version.name ?? KIND_LABELS[version.kind]
}

function formatTime(value: Date): string {
  return value.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

/**
 * The open project's history: browse versions, compare one with the current
 * design side by side, and restore it as a new revision.
 */
export function VersionHistoryDialog({
  onOpenChange,
  open,
  projectId,
}: {
  onOpenChange: (open: boolean) => void
  open: boolean
  projectId: string
}) {
  const trpcClient = useTRPCClient()
  const [versions, setVersions] = React.useState<Loaded<Version[]>>({ error: null, value: null })
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [selected, setSelected] = React.useState<Loaded<DesignDocument> & { id?: string }>({
    error: null,
    value: null,
  })
  const [current, setCurrent] = React.useState<{ local: DesignDocument; stored: DesignDocument }>()
  const [confirming, setConfirming] = React.useState(false)
  const [restoring, setRestoring] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    let active = true
    setVersions({ error: null, value: null })
    setCurrent({
      local: exportDesignDocument({ keepLocalSources: true }),
      stored: currentProjectDocument(),
    })
    trpcClient.project.versions
      .query({ projectId })
      .then((list) => {
        if (!active) return
        setVersions({ error: null, value: list })
        setSelectedId(list[0]?.id ?? null)
      })
      .catch((error: unknown) => active && setVersions({ error: errorMessage(error), value: null }))
    return () => {
      active = false
    }
  }, [open, projectId, trpcClient])

  React.useEffect(() => {
    if (!open || !selectedId) return
    let active = true
    setSelected({ error: null, id: selectedId, value: null })
    trpcClient.project.version
      .query({ projectId, versionId: selectedId })
      .then(
        (version) => active && setSelected({ error: null, id: selectedId, value: version.document })
      )
      .catch(
        (error: unknown) =>
          active && setSelected({ error: errorMessage(error), id: selectedId, value: null })
      )
    return () => {
      active = false
    }
  }, [open, projectId, selectedId, trpcClient])

  const version = versions.value?.find((item) => item.id === selectedId) ?? null
  const changes = selected.value && current ? changedSections(selected.value, current.stored) : null

  async function handleRestore() {
    if (!version) return
    setRestoring(true)
    try {
      await restoreProjectVersion(version.id)
      toast.success(`Restored “${versionTitle(version)}”`, {
        description: 'The design before it is kept in the history.',
      })
      setConfirming(false)
      onOpenChange(false)
    } catch (error) {
      toast.error('Could not restore the version', { description: errorMessage(error) })
    } finally {
      setRestoring(false)
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            Autosaves are kept every 10 minutes while you work; named versions are kept until the
            project is deleted.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 gap-4 md:grid-cols-[240px_1fr]">
          <div className="max-h-[60vh] overflow-y-auto rounded-lg border">
            {versions.error ? (
              <p className="p-4 text-sm text-destructive" role="alert">
                {versions.error}
              </p>
            ) : !versions.value ? (
              <p className="p-4 text-sm text-muted-foreground">Loading…</p>
            ) : versions.value.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                No versions yet. Save a version, or keep working and one is kept for you.
              </p>
            ) : (
              <ul aria-label="Versions" className="divide-y">
                {versions.value.map((item) => (
                  <li key={item.id}>
                    <Button variant="custom" size={null}
                      aria-current={item.id === selectedId ? 'true' : undefined}
                      className={cn(
                        'w-full px-3 py-2.5 text-left transition-colors hover:bg-foreground/[0.04]',
                        item.id === selectedId && 'bg-foreground/[0.07]'
                      )}
                      onClick={() => setSelectedId(item.id)}
                      type="button"
                    >
                      <span className="block truncate text-ui-lg font-medium">
                        {versionTitle(item)}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {formatTime(item.createdAt)}
                        {item.createdByName ? ` · ${item.createdByName}` : ''}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <figure className="min-w-0">
                <figcaption className="mb-1.5 truncate text-xs font-medium text-muted-foreground">
                  {version ? versionTitle(version) : 'Version'}
                </figcaption>
                <div className="aspect-[4/3] overflow-hidden rounded-lg border">
                  {selected.error ? (
                    <p className="grid h-full place-items-center p-3 text-xs text-destructive">
                      {selected.error}
                    </p>
                  ) : (
                    <ProjectPreview
                      alt={version ? `Preview of ${versionTitle(version)}` : 'Version preview'}
                      document={selected.value}
                      key={selected.id}
                    />
                  )}
                </div>
              </figure>
              <figure className="min-w-0">
                <figcaption className="mb-1.5 text-xs font-medium text-muted-foreground">
                  Current design
                </figcaption>
                <div className="aspect-[4/3] overflow-hidden rounded-lg border">
                  <DocumentPreview
                    alt="Preview of the current design"
                    document={current?.local ?? null}
                  />
                </div>
              </figure>
            </div>

            <div aria-live="polite" className="flex flex-wrap items-center gap-1.5 text-xs">
              {changes === null ? null : changes.length === 0 ? (
                <span className="text-muted-foreground">Same as the current design.</span>
              ) : (
                <>
                  <span className="text-muted-foreground">Differs in</span>
                  {changes.map((section) => (
                    <Pill key={section}>{sectionLabel(section)}</Pill>
                  ))}
                </>
              )}
            </div>

            <div className="flex justify-end">
              <Button
                disabled={!version || !selected.value || changes?.length === 0}
                onClick={() => setConfirming(true)}
                type="button"
              >
                Restore this version
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>

      <AlertDialog onOpenChange={restoring ? undefined : setConfirming} open={confirming}>
        <AlertDialogContent className="sm:max-w-[420px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this version?</AlertDialogTitle>
            <AlertDialogDescription>
              {version ? `“${versionTitle(version)}” becomes the current design. ` : ''}
              The design it replaces stays in the history, and you can undo it with ⌘Z.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoring}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={restoring}
              onClick={(event) => {
                event.preventDefault()
                void handleRestore()
              }}
            >
              {restoring ? 'Restoring…' : 'Restore'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
