'use client'

import { SidebarLink as Link } from '@/components/platform-shell/SidebarLink'
import { usePathname } from 'next/navigation'
import { platformHref } from '@/lib/platform/navigation'
import { prepareWorkspaceSwitch } from '@/lib/platform/navigation-guard'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useRef, useState } from 'react'
import { WorkspaceCreationDialog } from '@/components/workspace/WorkspaceCreationDialog'
import { UserAvatar } from './UserAvatar'
import { announceSessionChange, authClient, useHydratedSession } from '@/lib/auth/client'
import { resetUser } from '@/lib/analytics'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useTRPC, useTRPCClient } from '@/lib/trpc/react'
import { Button } from '@/components/ui/button'

type Workspace = { id: string; isScheduledForDeletion: boolean; name: string; slug: string }

export function AccountMenu({
  scope = 'all',
  align = 'end',
  children,
  side = 'bottom',
  triggerClassName,
  workspaceName,
}: {
  scope?: 'all' | 'account' | 'workspace'
  align?: 'center' | 'end' | 'start'
  /** Custom trigger content, e.g. the sidebar's workspace row; defaults to an avatar. */
  children?: ReactNode
  /** Where the menu opens; the sidebar opens it upward or to the right. */
  side?: 'bottom' | 'right' | 'top'
  triggerClassName?: string
  /** The active workspace, shown in the menu so it is named even when the trigger is a badge. */
  workspaceName?: string
} = {}) {
  const queryClient = useQueryClient()
  const pathname = usePathname()
  const trpcClient = useTRPCClient()
  const trpc = useTRPC()
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [isSwitchingWorkspace, setIsSwitchingWorkspace] = useState(false)
  const [workspaceError, setWorkspaceError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [creationOpen, setCreationOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const { data: session, isPending } = useHydratedSession()

  // Only the open menu lists workspaces; the shell remounts on every page, so read it on demand and cache it.
  const listsWorkspaces = Boolean(session) && scope !== 'account'
  const workspaceList = trpc.workspace.listMine.queryOptions(undefined, { staleTime: 5 * 60_000 })
  const workspaces: Workspace[] =
    useQuery({ ...workspaceList, enabled: listsWorkspaces && menuOpen }).data?.workspaces ?? []
  const prefetchWorkspaces = () => {
    if (listsWorkspaces) void queryClient.prefetchQuery(workspaceList)
  }

  async function handleSignOut() {
    setIsSigningOut(true)
    setWorkspaceError(null)
    try {
      await prepareWorkspaceSwitch()
      const result = await authClient.signOut()
      if (result.error) throw new Error(result.error.message ?? 'Could not sign out.')
      resetUser()
      queryClient.clear()
      window.location.assign(platformHref(pathname, '/sign-in'))
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : 'Could not sign out.')
      setIsSigningOut(false)
    }
  }

  async function handleWorkspaceSwitch(organizationId: string): Promise<void> {
    if (organizationId === session?.session.activeOrganizationId) {
      return
    }

    setWorkspaceError(null)
    setIsSwitchingWorkspace(true)
    try {
      await prepareWorkspaceSwitch()
      await trpcClient.workspace.setActive.mutate({ organizationId })
      announceSessionChange()
      queryClient.clear()
      window.location.assign(platformHref(pathname, '/home'))
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : 'Could not switch workspace.')
      setIsSwitchingWorkspace(false)
    }
  }

  if (isPending) return <div aria-hidden className={triggerClassName ?? 'h-8 w-8'} />

  if (!session) {
    return (
      <Link
        href="/sign-in"
        className="rounded-md px-2.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        Sign in
      </Link>
    )
  }

  const name = session.user.name || session.user.email
  const hasUnavailableActiveWorkspace = Boolean(
    session.session.activeOrganizationId &&
    !workspaces.some((workspace) => workspace.id === session.session.activeOrganizationId)
  )
  const canSwitchWorkspace = workspaces.length > 1 || hasUnavailableActiveWorkspace

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="custom"
            size={null}
            aria-label={
              scope === 'workspace'
                ? `Workspace: ${workspaceName ?? 'Workspace'}`
                : 'Open account menu'
            }
            ref={trigger}
            onFocus={prefetchWorkspaces}
            onPointerEnter={prefetchWorkspaces}
            className={
              triggerClassName ??
              'flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-opacity hover:opacity-80'
            }
            type="button"
          >
            {children ?? <UserAvatar name={name} image={session.user.image} />}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align={align}
          className="platform-overlay w-72 max-w-[calc(100vw-2rem)] p-2"
          side={side}
          onCloseAutoFocus={(event) => {
            if (creationOpen) event.preventDefault()
          }}
        >
          <div className="min-w-0 border-b px-2 py-2.5">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="break-all text-xs text-muted-foreground">{session.user.email}</p>
            {workspaceName ? (
              <p className="mt-1.5 truncate text-xs text-muted-foreground">
                Workspace: <span className="text-foreground">{workspaceName}</span>
              </p>
            ) : null}
          </div>
          {scope !== 'account' && canSwitchWorkspace ? (
            <div className="grid gap-1 border-b py-2">
              <p className="px-2 text-xs font-medium text-muted-foreground">Workspaces</p>
              {workspaces.map((workspace) => {
                const isActive = workspace.id === session.session.activeOrganizationId
                return (
                  <Button
                    variant="custom"
                    size={null}
                    aria-current={isActive ? 'page' : undefined}
                    aria-label={`Switch to ${workspace.name}`}
                    className="w-full rounded-md px-2 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={isActive || isSwitchingWorkspace}
                    key={workspace.id}
                    onClick={() => void handleWorkspaceSwitch(workspace.id)}
                    type="button"
                  >
                    <span className="block truncate">{workspace.name}</span>
                    {workspace.isScheduledForDeletion ? (
                      <span className="block text-xs text-destructive">Deletion scheduled</span>
                    ) : null}
                  </Button>
                )
              })}
            </div>
          ) : null}
          {workspaceError ? (
            <p className="px-2 pb-2 text-xs text-destructive">{workspaceError}</p>
          ) : null}
          <div className="grid gap-1 py-2">
            {scope !== 'account' ? (
              <>
                <Button
                  variant="custom"
                  size={null}
                  className="rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    setMenuOpen(false)
                    setCreationOpen(true)
                  }}
                >
                  Create workspace
                </Button>
              </>
            ) : null}
            {scope !== 'workspace' ? (
              <>
                <Link
                  className="rounded-md px-2 py-2 text-sm hover:bg-muted"
                  href="/settings/account"
                >
                  Profile
                </Link>
                <Link
                  className="rounded-md px-2 py-2 text-sm hover:bg-muted"
                  href="/settings/appearance"
                >
                  Preferences
                </Link>
                <Link className="rounded-md px-2 py-2 text-sm hover:bg-muted" href="/settings">
                  Settings
                </Link>
              </>
            ) : null}
          </div>
          {scope !== 'workspace' ? (
            <Button
              variant="custom"
              size={null}
              className="w-full rounded-md px-2 py-2 text-left text-sm text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isSigningOut}
              onClick={handleSignOut}
              type="button"
            >
              {isSigningOut ? 'Signing out…' : 'Sign out'}
            </Button>
          ) : null}
        </PopoverContent>
      </Popover>
      {creationOpen ? (
        <WorkspaceCreationDialog
          key={session.user.id}
          email={session.user.email}
          userId={session.user.id}
          onClose={() => setCreationOpen(false)}
          returnFocusRef={trigger}
          onCreated={() => void queryClient.invalidateQueries({ queryKey: workspaceList.queryKey })}
        />
      ) : null}
    </>
  )
}
