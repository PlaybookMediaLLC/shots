'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { WarningIcon as Alert02Icon } from '@phosphor-icons/react/dist/ssr/Warning'
import { CaretDownIcon as ArrowDown01Icon } from '@phosphor-icons/react/dist/ssr/CaretDown'
import { CopyIcon as Copy01Icon } from '@phosphor-icons/react/dist/ssr/Copy'
import { FloppyDiskIcon as FloppyDiskIcon } from '@phosphor-icons/react/dist/ssr/FloppyDisk'
import { FolderOpenIcon as Folder01Icon } from '@phosphor-icons/react/dist/ssr/FolderOpen'
import { NotePencilIcon as PencilEdit01Icon } from '@phosphor-icons/react/dist/ssr/NotePencil'
import { ClockCounterClockwiseIcon as WorkHistoryIcon } from '@phosphor-icons/react/dist/ssr/ClockCounterClockwise'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useHydratedSession } from '@/lib/auth/client'
import type { ProjectSaveStatus } from '@/lib/projects/schema'
import {
  closeProject,
  createProjectFromEditor,
  duplicateOpenProject,
  loadLatestProject,
  renameOpenProject,
  saveConflictCopy,
  saveNamedVersion,
  useProjectSession,
} from '@/lib/projects/session'
import { useTRPCClient } from '@/lib/trpc/react'
import { cn } from '@/lib/utils'
import { ProjectNameDialog } from './ProjectNameDialog'
import { VersionHistoryDialog } from './VersionHistoryDialog'
import { Button } from '@/components/ui/button'

const STATUS_LABELS: Record<ProjectSaveStatus, string> = {
  conflict: 'Not saved: changed elsewhere',
  error: 'Not saved',
  loading: 'Opening…',
  offline: 'Offline, saved on this device',
  saved: 'Saved to workspace',
  saving: 'Saving…',
  unsaved: 'Unsaved changes',
}

const STATUS_TONES: Record<ProjectSaveStatus, string> = {
  conflict: 'bg-destructive',
  error: 'bg-destructive',
  loading: 'bg-muted-foreground',
  offline: 'bg-amber-500',
  saved: 'bg-emerald-500',
  saving: 'bg-muted-foreground animate-pulse',
  unsaved: 'bg-muted-foreground',
}

type NameDialog = 'create' | 'rename' | 'version' | null

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

/**
 * The project the editor is working on: its name and save status, and what
 * can be done with it. With no project open it offers to save the canvas as one.
 */
export function ProjectMenu({ compact = false }: { compact?: boolean }) {
  const trpcClient = useTRPCClient()
  const router = useRouter()
  const { data: session, isPending } = useHydratedSession()
  const project = useProjectSession()
  const [nameDialog, setNameDialog] = React.useState<NameDialog>(null)
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const [conflictDismissed, setConflictDismissed] = React.useState(false)
  const [resolving, setResolving] = React.useState(false)

  React.useEffect(() => {
    if (project.status !== 'conflict') setConflictDismissed(false)
  }, [project.status])

  if (isPending || !session) return null

  async function run(action: () => Promise<unknown>, success: string, failure: string) {
    try {
      await action()
      toast.success(success)
    } catch (error) {
      toast.error(failure, { description: errorMessage(error) })
    }
  }

  async function resolve(choice: 'latest' | 'copy') {
    setResolving(true)
    try {
      if (choice === 'latest') {
        await loadLatestProject()
        toast.success('Loaded the saved project')
      } else {
        const copy = await saveConflictCopy()
        toast.success(`Saved your changes as “${copy.name}”`)
      }
    } catch (error) {
      toast.error('Could not resolve the conflict', { description: errorMessage(error) })
    } finally {
      setResolving(false)
    }
  }

  const dialogs = (
    <>
      <ProjectNameDialog
        description="Projects save as you work and keep a version history."
        label="Project name"
        maxLength={200}
        onOpenChange={(open) => setNameDialog(open ? 'create' : null)}
        onSubmit={async (name) => {
          await createProjectFromEditor(trpcClient, name)
          toast.success(`Saved “${name}”`, {
            action: { label: 'All projects', onClick: () => router.push('/projects') },
          })
        }}
        open={nameDialog === 'create'}
        submitLabel="Save project"
        title="Save as project"
      />
      <ProjectNameDialog
        initialName={project.name}
        label="Project name"
        maxLength={200}
        onOpenChange={(open) => setNameDialog(open ? 'rename' : null)}
        onSubmit={renameOpenProject}
        open={nameDialog === 'rename'}
        submitLabel="Rename"
        title="Rename project"
      />
      <ProjectNameDialog
        description="A named version is kept until the project is deleted."
        label="Version name"
        maxLength={120}
        onOpenChange={(open) => setNameDialog(open ? 'version' : null)}
        onSubmit={async (name) => {
          await saveNamedVersion(name)
          toast.success(`Saved version “${name}”`)
        }}
        open={nameDialog === 'version'}
        submitLabel="Save version"
        title="Save a version"
      />
    </>
  )

  if (!project.projectId) {
    return (
      <>
        <Button
          variant="custom"
          size={null}
          className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          onClick={() => setNameDialog('create')}
          type="button"
        >
          <FloppyDiskIcon className="shrink-0" size={15} />
          {!compact ? <span className="whitespace-nowrap">Save as project</span> : null}
          {compact ? <span className="sr-only">Save as project</span> : null}
        </Button>
        {dialogs}
      </>
    )
  }

  const busy = project.status === 'loading'
  const statusLabel = STATUS_LABELS[project.status]

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="custom"
            size={null}
            aria-label={`Project ${project.name || ''}: ${statusLabel}`}
            className="inline-flex h-8 min-w-0 max-w-[260px] cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.06] data-[state=open]:bg-foreground/[0.08]"
            type="button"
          >
            <span
              aria-hidden
              className={cn('size-1.5 shrink-0 rounded-full', STATUS_TONES[project.status])}
            />
            {!compact ? (
              <span className="truncate">{project.name || 'Opening project…'}</span>
            ) : null}
            <ArrowDown01Icon className="shrink-0 text-muted-foreground" size={13} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64" sideOffset={8}>
          <DropdownMenuLabel className="font-normal">
            <span className="block truncate text-ui-lg font-medium">{project.name}</span>
            <span
              className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground"
              data-testid="project-save-status"
            >
              {project.status === 'error' || project.status === 'conflict' ? (
                <Alert02Icon className="text-destructive" size={12} />
              ) : null}
              {statusLabel}
            </span>
            {project.error && project.status !== 'saved' ? (
              <span className="mt-1 block text-xs text-muted-foreground">{project.error}</span>
            ) : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {project.status === 'conflict' ? (
            <DropdownMenuItem onSelect={() => setConflictDismissed(false)}>
              <Alert02Icon size={15} />
              Resolve conflict…
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem disabled={busy} onSelect={() => setNameDialog('rename')}>
            <PencilEdit01Icon size={15} />
            Rename…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onSelect={() => setNameDialog('version')}>
            <FloppyDiskIcon size={15} />
            Save version…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onSelect={() => setHistoryOpen(true)}>
            <WorkHistoryIcon size={15} />
            Version history
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={busy}
            onSelect={() =>
              void run(
                duplicateOpenProject,
                'Duplicated. You are now editing the copy.',
                'Could not duplicate the project'
              )
            }
          >
            <Copy01Icon size={15} />
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/projects">
              <Folder01Icon size={15} />
              All projects
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              closeProject()
              toast('Project closed', { description: 'The canvas is no longer saved to it.' })
            }}
          >
            Close project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {dialogs}
      <VersionHistoryDialog
        onOpenChange={setHistoryOpen}
        open={historyOpen}
        projectId={project.projectId}
      />

      <AlertDialog
        onOpenChange={(open) => !open && !resolving && setConflictDismissed(true)}
        open={project.status === 'conflict' && !conflictDismissed}
      >
        <AlertDialogContent className="sm:max-w-[460px]">
          <AlertDialogHeader>
            <AlertDialogTitle>This project changed elsewhere</AlertDialogTitle>
            <AlertDialogDescription>
              {project.error ?? 'Someone saved this project after you opened it.'} Saving is paused
              so neither version is lost. Load the saved project, or keep your changes as a new
              project.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              className="bg-transparent text-foreground ring-1 ring-foreground/15 hover:bg-foreground/[0.06]"
              disabled={resolving}
              onClick={(event) => {
                event.preventDefault()
                void resolve('latest')
              }}
            >
              Load saved project
            </AlertDialogAction>
            <AlertDialogAction
              disabled={resolving}
              onClick={(event) => {
                event.preventDefault()
                void resolve('copy')
              }}
            >
              Keep mine as a copy
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
