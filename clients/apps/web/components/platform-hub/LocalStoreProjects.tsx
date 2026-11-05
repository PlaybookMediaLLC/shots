'use client'

import { useEffect, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  StoreIcon as DeviceMobileIcon,
  MoreIcon as MoreHorizontalIcon,
} from '@/components/platform-shell/icons'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { EmptyState } from '@/components/platform-ui'
import { listProjects, type ProjectSummary } from '@/lib/store-screenshots/persistence/projects'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useHydratedSession } from '@/lib/auth/client'
import { STORE_SCREENSHOTS } from '@/lib/platform/navigation'
import { deleteWorkspaceCopy } from '@/lib/store-screenshots/workspace'
import { useTRPC, useTRPCClient } from '@/lib/trpc/react'

const projectHref = (id: string) => `${STORE_SCREENSHOTS.href}/${encodeURIComponent(id)}`

/**
 * Store screenshot projects: those saved to the workspace, which open on any
 * device, then those only on this browser. Listing never copies or changes them.
 */
export function LocalStoreProjects({ canEdit }: { canEdit: boolean }) {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const { data: session } = useHydratedSession()
  const organizationId = session?.session.activeOrganizationId ?? null
  const [deleting, setDeleting] = useState<{ projectId: string; name: string } | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const saved = useInfiniteQuery(
    trpc.storeProject.list.infiniteQueryOptions({}, { getNextPageParam: (page) => page.nextCursor })
  )
  const savedItems = saved.data?.pages.flatMap((page) => page.items) ?? []
  const savedIds = new Set(savedItems.map((item) => item.projectId))
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [query, setQuery] = useState('')
  useEffect(() => {
    let active = true
    setError(null)
    void listProjects().then(
      (items) => {
        if (active) setProjects(items)
      },
      (failure: unknown) => {
        if (active)
          setError(failure instanceof Error ? failure.message : 'Local projects could not load.')
      }
    )
    return () => {
      active = false
    }
  }, [attempt])
  const matches = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase())
  const shownSaved = savedItems.filter((item) => matches(item.name))
  // A project saved to the workspace is listed there once, not again as a local copy.
  const shown = projects?.filter((item) => !savedIds.has(item.id) && matches(item.name))
  return (
    <section className="space-y-4" aria-label="Store screenshot projects">
      <Input
        aria-label="Search store projects"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search store projects"
      />
      <h2 className="text-ui-lg font-semibold">In this workspace</h2>
      {saved.error ? (
        <div role="alert">
          <p>Workspace store projects could not load.</p>
          <Button variant="outline" onClick={() => void saved.refetch()}>
            Retry workspace projects
          </Button>
        </div>
      ) : saved.isPending ? (
        <p role="status">Loading workspace projects…</p>
      ) : shownSaved.length ? (
        <ul className="studio-grid">
          {shownSaved.map((item) => (
            <li className="studio-shot" key={item.projectId}>
              <div className="studio-shot-media">
                <span className="grid size-full place-items-center text-sm text-muted-foreground">
                  {item.slideCount} slides
                </span>
                <span aria-hidden="true" className="studio-shot-overlay">
                  {item.name}
                </span>
                <SidebarLink
                  aria-label={`Open ${item.name}`}
                  href={projectHref(item.projectId)}
                  className="absolute inset-0 z-[2] rounded-[inherit]"
                />
              </div>
              <div className="studio-shot-meta">
                <span className="min-w-0 flex-1">
                  <SidebarLink
                    href={projectHref(item.projectId)}
                    className="block truncate font-medium hover:underline"
                  >
                    {item.name}
                  </SidebarLink>
                  <span className="block truncate text-xs text-muted-foreground">
                    {STORE_SCREENSHOTS.label} · In this workspace ·{' '}
                    {item.updatedAt.toLocaleDateString()}
                  </span>
                </span>
                {canEdit ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button aria-label={`Actions for ${item.name}`} size="icon" variant="ghost">
                        <MoreHorizontalIcon size={16} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setDeleting({ projectId: item.projectId, name: item.name })}
                      >
                        Delete from workspace…
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          {query
            ? 'No workspace projects match this search.'
            : 'None yet. Open a project and choose Save to workspace to see it here on every device.'}
        </p>
      )}
      {saved.hasNextPage ? (
        <Button
          variant="outline"
          disabled={saved.isFetchingNextPage}
          onClick={() => void saved.fetchNextPage()}
        >
          Show more workspace projects
        </Button>
      ) : null}
      <h2 className="text-ui-lg font-semibold">On this browser</h2>
      <p className="text-sm text-muted-foreground">
        These projects belong to this browser profile. Save one to your workspace to open it on
        other devices.
      </p>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            Retry local projects
          </Button>
        </div>
      ) : projects === null ? (
        <p role="status">Loading local projects…</p>
      ) : shown?.length ? (
        <ul className="studio-grid">
          {shown.map((item) => (
            <li className="studio-shot" key={item.id}>
              <SidebarLink
                href={projectHref(item.id)}
                className="block"
              >
                <span className="studio-shot-media">
                  {item.thumbnail ? (
                    <img src={item.thumbnail} alt="" className="size-full object-contain" />
                  ) : (
                    <span className="grid size-full place-items-center text-sm text-muted-foreground">
                      {item.slideCount} slides
                    </span>
                  )}
                  <span aria-hidden="true" className="studio-shot-overlay">
                    {item.name}
                  </span>
                </span>
                <span className="studio-shot-meta">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {STORE_SCREENSHOTS.label} · On this browser ·{' '}
                      {new Date(item.updatedAt).toLocaleDateString()}
                    </span>
                  </span>
                </span>
              </SidebarLink>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={DeviceMobileIcon}
          title={query ? 'No matching store projects' : 'No store projects on this browser'}
          description={
            query
              ? 'No local projects match this search.'
              : 'Store screenshot projects are saved on the browser that made them. Build one to see it here.'
          }
          action={<ButtonLink href={STORE_SCREENSHOTS.href}>Open {STORE_SCREENSHOTS.label}</ButtonLink>}
        />
      )}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && !deletePending && setDeleting(null)}
      >
        <AlertDialogContent className="sm:max-w-[420px]">
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">
              Delete “{deleting?.name}” from the workspace?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The workspace copy and its versions are deleted, so it leaves Library on every device.
              Browsers that opened it keep their own copy. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deletePending || !organizationId}
              onClick={(event) => {
                event.preventDefault()
                if (!deleting || !organizationId) return
                setDeletePending(true)
                void deleteWorkspaceCopy(client, organizationId, deleting.projectId)
                  .then(async () => {
                    toast.success(`Deleted “${deleting.name}” from the workspace.`)
                    setDeleting(null)
                    await saved.refetch()
                  })
                  .catch((cause: unknown) =>
                    toast.error('Could not delete the workspace copy', {
                      description: cause instanceof Error ? cause.message : undefined,
                    })
                  )
                  .finally(() => setDeletePending(false))
              }}
            >
              {deletePending ? 'Deleting…' : 'Delete from workspace'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
