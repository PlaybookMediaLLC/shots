'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { bindBrowserScope } from '@/lib/auth/browser-scope'
import { announceSessionChange, authClient, useHydratedSession } from '@/lib/auth/client'
import { platformHref } from '@/lib/platform/navigation'
import { settingsErrorMessage } from '@/lib/settings/client'
import { useTRPC, useTRPCClient } from '@/lib/trpc/react'

/**
 * A browser's tabs share one active workspace. When another tab switches it,
 * this tab still shows its own workspace while its session now points at the
 * other one. `bindBrowserScope` makes the server refuse this tab's requests
 * from then on, so nothing lands in the wrong workspace, and this banner says
 * why and offers the way back, without stopping what the person is reading.
 */
export function WorkspaceTabGuard({
  workspaceId,
  workspaceName,
}: {
  /** The workspace this page was rendered for. */
  workspaceId: string
  workspaceName: string
}) {
  const { data: session } = useHydratedSession()
  const active = session?.session.activeOrganizationId
  const userId = session?.user.id
  useEffect(
    () => (userId ? bindBrowserScope({ userId, workspaceId }) : undefined),
    [userId, workspaceId]
  )
  const stale = Boolean(active && active !== workspaceId)
  const pathname = usePathname()
  const queryClient = useQueryClient()
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const workspaces = useQuery({
    ...trpc.workspace.listMine.queryOptions(undefined, { staleTime: 5 * 60_000 }),
    enabled: stale,
  })
  const other = workspaces.data?.workspaces.find((workspace) => workspace.id === active)?.name
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function stay() {
    setBusy(true)
    setError(null)
    try {
      await trpcClient.workspace.setActive.mutate({ organizationId: workspaceId })
      announceSessionChange()
      authClient.$store.notify('$sessionSignal')
      // Anything this tab read meanwhile came from the other workspace.
      await queryClient.invalidateQueries()
    } catch (cause) {
      setError(settingsErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  if (!stale) return null
  return (
    <div
      className="fixed inset-x-0 top-2 z-50 mx-auto flex w-fit max-w-[calc(100%-1rem)] flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-400/50 bg-card px-3 py-2 text-sm shadow-popover"
      data-testid="workspace-banner"
      role="status"
    >
      <span>
        This tab is in {workspaceName}. You switched to {other ?? 'another workspace'} in another
        tab, so nothing here saves until you choose.
      </span>
      {error ? (
        <span className="text-destructive" role="alert">
          {error}
        </span>
      ) : null}
      <Button disabled={busy} onClick={() => void stay()} size="sm">
        {busy ? 'Switching…' : `Keep working in ${workspaceName}`}
      </Button>
      <Button
        disabled={busy}
        onClick={() => window.location.assign(platformHref(pathname, '/home'))}
        size="sm"
        variant="outline"
      >
        Open {other ?? 'the other workspace'}
      </Button>
    </div>
  )
}
