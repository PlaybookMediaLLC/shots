'use client'

import * as React from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { ImageIcon } from '@/components/platform-shell/icons'
import { useRouter, useSearchParams } from 'next/navigation'
import { FolderIcon as Folder01Icon } from '@/components/platform-shell/icons'
import { MoreIcon as MoreHorizontalIcon } from '@/components/platform-shell/icons'
import { SearchIcon as Search01Icon } from '@/components/platform-shell/icons'
import { toast } from 'sonner'
import { EmptyState } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { DESIGN_DOCUMENT_VERSION, type DesignDocument } from '@/lib/design/document'
import { type ProjectSort, projectSortSchema } from '@/lib/projects/schema'
import { forgetProject } from '@/lib/projects/session'
import { useTRPC, useTRPCClient } from '@/lib/trpc/react'
import { ProjectNameDialog } from './ProjectNameDialog'
import { ProjectPreview } from './ProjectPreview'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select'

type LibraryProject = {
  document: DesignDocument | null
  id: string
  name: string
  updatedAt: Date
}

const PAGE_SIZE = 24
const SORT_LABELS: Record<ProjectSort, string> = { name: 'Name', updated: 'Last edited' }

function shortName(name: string): string {
  return name.length > 60 ? `${name.slice(0, 57)}…` : name
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

function editorHref(projectId: string): string {
  return `/editor?project=${encodeURIComponent(projectId)}`
}

/** The workspace's projects: search, open, rename, duplicate, delete, and start new ones. */
export function ProjectLibrary({ canEdit }: { canEdit: boolean }) {
  const trpcClient = useTRPCClient()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const router = useRouter()
  const params = useSearchParams()
  const query = (params.get('search') ?? '').trim().slice(0, 200)
  const sort = projectSortSchema.safeParse(params.get('sort')).data ?? 'updated'
  const [search, setSearch] = React.useState(query)
  const options = trpc.project.list.infiniteQueryOptions(
    { limit: PAGE_SIZE, search: query || undefined, sort },
    { getNextPageParam: (page) => page.nextCursor }
  )
  const projects = useInfiniteQuery(options)
  // Library opens where the work is: with no projects yet, that is saved files.
  const noProjects = projects.isSuccess && !query && !projects.data.pages[0]?.items.length
  const saved = useQuery(
    trpc.asset.list.queryOptions({ limit: 1 }, { enabled: noProjects, staleTime: 30_000 })
  )
  const hasAssets = noProjects && Boolean(saved.data?.assets.length)
  React.useEffect(() => {
    if (hasAssets) router.replace('/library?view=assets')
  }, [hasAssets, router])
  const page = {
    items: projects.data?.pages.flatMap((page) => page.items) ?? [],
    loading: projects.isPending || projects.isFetchingNextPage,
    error: projects.error ? errorMessage(projects.error) : null,
    next: projects.hasNextPage,
  }
  const [creating, setCreating] = React.useState(false)
  const [renaming, setRenaming] = React.useState<LibraryProject | null>(null)
  const [deleting, setDeleting] = React.useState<LibraryProject | null>(null)
  const [deletePending, setDeletePending] = React.useState(false)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const actionButtons = React.useRef(new Map<string, HTMLButtonElement>())
  const returnFocus = React.useRef<HTMLElement | null>(null)

  function restoreFocus(event: Event) {
    event.preventDefault()
    requestAnimationFrame(() => {
      const target = returnFocus.current
      if (target?.isConnected) target.focus()
      else searchRef.current?.focus()
    })
  }

  function updateFilters(nextSearch: string, nextSort: ProjectSort) {
    const url = new URL(window.location.href)
    if (nextSearch) url.searchParams.set('search', nextSearch)
    else url.searchParams.delete('search')
    if (nextSort === 'updated') url.searchParams.delete('sort')
    else url.searchParams.set('sort', nextSort)
    window.history.replaceState(null, '', url)
  }

  React.useEffect(() => setSearch(query), [query])

  React.useEffect(() => {
    if (search.trim() === query) return
    const timer = setTimeout(() => updateFilters(search.trim(), sort), 250)
    return () => clearTimeout(timer)
  }, [query, search, sort])

  async function duplicate(project: LibraryProject) {
    try {
      const copy = await trpcClient.project.duplicate.mutate({ projectId: project.id })
      toast.success(`Duplicated as “${shortName(copy.name)}”`)
    } catch (error) {
      toast.error('Could not duplicate the project', { description: errorMessage(error) })
    }
  }

  async function confirmDelete() {
    if (!deleting) return
    setDeletePending(true)
    try {
      await trpcClient.project.delete.mutate({ projectId: deleting.id })
      forgetProject(deleting.id)
      queryClient.setQueryData(options.queryKey, (current) =>
        current
          ? {
              ...current,
              pages: current.pages.map((page) => ({
                ...page,
                items: page.items.filter((item) => item.id !== deleting.id),
              })),
            }
          : current
      )
      toast.success(`Deleted “${shortName(deleting.name)}”`)
      setDeleting(null)
    } catch (error) {
      toast.error('Could not delete the project', { description: errorMessage(error) })
    } finally {
      setDeletePending(false)
    }
  }

  const empty = !page.loading && !page.error && page.items.length === 0

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-xs">
          <Search01Icon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
            size={15}
          />
          <Input
            ref={searchRef}
            maxLength={200}
            aria-label="Search projects"
            className="rounded-full pl-9"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search projects"
            type="search"
            value={search}
          />
        </div>
        <Label className="flex items-center gap-2 text-sm text-foreground/65 sm:ml-auto">
          Sort
          <Select
            onValueChange={(nextValue) =>
              updateFilters(search.trim(), projectSortSchema.parse(nextValue))
            }
            value={sort}
          >
            <SelectTrigger
              aria-label="Sort projects"
              className="h-9 rounded-full border border-foreground/10 bg-transparent px-3 text-sm text-foreground"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {projectSortSchema.options.map((option) => (
                <SelectItem key={option} value={option}>
                  {SORT_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Label>
        {canEdit ? (
          <Button
            onClick={(event) => {
              returnFocus.current = event.currentTarget
              setCreating(true)
            }}
          >
            New project
          </Button>
        ) : null}
      </div>

      {page.error ? (
        <Alert variant="destructive">
          <AlertDescription>
            {page.error}{' '}
            <Button
              variant="custom"
              size={null}
              className="underline"
              onClick={() => void projects.refetch()}
              type="button"
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {empty ? (
        <EmptyState
          action={
            canEdit && !query ? (
              <Button
                onClick={(event) => {
                  returnFocus.current = event.currentTarget
                  setCreating(true)
                }}
              >
                New project
              </Button>
            ) : undefined
          }
          description={
            query
              ? `No project name contains “${query}”.`
              : 'Save a design from the editor as a project, or start a new one here.'
          }
          icon={Folder01Icon}
          title={query ? 'No matching projects' : 'No projects yet'}
        />
      ) : (
        <ul aria-busy={page.loading} className="studio-grid">
          {page.items.map((project) => (
            <li className="studio-shot group" key={project.id}>
              <div className="studio-shot-media">
                <ProjectPreview
                  className="studio-cover"
                  retryable
                  alt={`Preview of ${project.name}`}
                  document={project.document}
                />
                <span aria-hidden="true" className="studio-shot-overlay">
                  {project.name}
                </span>
                <Link
                  aria-label={`Open ${project.name}`}
                  href={editorHref(project.id)}
                  className="absolute inset-0 z-[2] rounded-[inherit] focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-ring"
                />
              </div>
              <div className="studio-shot-meta">
                <span aria-hidden="true" className="studio-shot-kind">
                  <ImageIcon size={12} />
                </span>
                <div className="min-w-0 flex-1">
                  <Link
                    className="block truncate font-medium text-foreground hover:underline"
                    href={editorHref(project.id)}
                    title={project.name}
                  >
                    {project.name}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground">
                    Screenshot · Edited{' '}
                    {project.updatedAt.toLocaleString(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </p>
                </div>
                {canEdit ? (
                  <DropdownMenu
                    onOpenChange={(open) => {
                      if (open) returnFocus.current = actionButtons.current.get(project.id) ?? null
                    }}
                  >
                    <DropdownMenuTrigger asChild>
                      <Button
                        ref={(button) => {
                          if (button) actionButtons.current.set(project.id, button)
                          else actionButtons.current.delete(project.id)
                        }}
                        aria-label={`Actions for ${project.name}`}
                        size="icon"
                        variant="ghost"
                      >
                        <MoreHorizontalIcon size={16} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      onCloseAutoFocus={(event) => {
                        if (renaming || deleting) event.preventDefault()
                        else restoreFocus(event)
                      }}
                    >
                      <DropdownMenuItem onSelect={() => router.push(editorHref(project.id))}>
                        Open
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => router.push(`/canvas/new?project=${project.id}`)}
                      >
                        Create Canvas copy
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setRenaming(project)}>
                        Rename…
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void duplicate(project)}>
                        Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onSelect={() => {
                          void trpcClient.project.get
                            .query({ projectId: project.id })
                            .then((latest) => {
                              setDeleting({
                                ...project,
                                updatedAt: latest.updatedAt,
                                name: latest.name,
                              })
                              void projects.refetch()
                            })
                            .catch((error: unknown) =>
                              toast.error(
                                error instanceof Error ? error.message : 'Could not load project.'
                              )
                            )
                        }}
                        variant="destructive"
                      >
                        Delete…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {page.loading ? <p className="text-sm text-muted-foreground">Loading projects…</p> : null}
      {page.next && !page.loading ? (
        <div className="flex justify-center">
          <Button onClick={() => void projects.fetchNextPage()} variant="outline">
            Load more
          </Button>
        </div>
      ) : null}

      <ProjectNameDialog
        onCloseAutoFocus={restoreFocus}
        description="Start from a blank canvas. It saves as you work."
        label="Project name"
        maxLength={200}
        onOpenChange={setCreating}
        onSubmit={async (name) => {
          const project = await trpcClient.project.create.mutate({
            document: { image: { src: null }, version: DESIGN_DOCUMENT_VERSION },
            name,
          })
          router.push(editorHref(project.id))
        }}
        open={creating}
        submitLabel="Create project"
        title="New project"
      />
      <ProjectNameDialog
        onCloseAutoFocus={restoreFocus}
        initialName={renaming?.name ?? ''}
        label="Project name"
        maxLength={200}
        onOpenChange={(open) => !open && setRenaming(null)}
        onSubmit={async (name) => {
          if (!renaming) return
          await trpcClient.project.rename.mutate({ name, projectId: renaming.id })
          await queryClient.invalidateQueries({ queryKey: trpc.project.list.queryKey() })
          if (query && !name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
            returnFocus.current = searchRef.current
          }
        }}
        open={renaming !== null}
        submitLabel="Rename"
        title="Rename project"
      />

      <AlertDialog
        onOpenChange={(open) => !open && !deletePending && setDeleting(null)}
        open={deleting !== null}
      >
        <AlertDialogContent className="sm:max-w-[420px]" onCloseAutoFocus={restoreFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The project and its whole version history are deleted for everyone in the workspace.
              This cannot be undone. Images saved to Assets stay.
              {deleting ? (
                <>
                  {' '}
                  Last edited{' '}
                  {deleting.updatedAt.toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                  . Project ID: {deleting.id}.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deletePending}
              onClick={(event) => {
                event.preventDefault()
                void confirmDelete()
              }}
            >
              {deletePending ? 'Deleting…' : 'Delete project'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
