'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { announceSessionChange, authClient, useHydratedSession } from '@/lib/auth/client'
import { platformHref } from '@/lib/platform/navigation'
import { settingsErrorMessage } from '@/lib/settings/client'
import { useTRPC, useTRPCClient } from '@/lib/trpc/react'

/**
 * A browser's tabs share one active workspace. When another tab switches it,
 * this tab still shows its own workspace while its requests now run in the
 * other one, so a save or a new item would land there. The page waits behind
 * this dialog until the person picks the workspace to work in.
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
  // A click landing as this opens is dropped on purpose: it would run in the other
  // workspace. It should not vanish silently, so the dialog says so.
  const lastPress = useRef(0)
  const [clickDropped, setClickDropped] = useState(false)
  useEffect(() => {
    const note = () => {
      lastPress.current = Date.now()
    }
    window.addEventListener('pointerdown', note, { capture: true })
    return () => window.removeEventListener('pointerdown', note, { capture: true })
  }, [])
  useEffect(() => {
    if (stale) setClickDropped(Date.now() - lastPress.current < 2000)
  }, [stale])

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

  return (
    <AlertDialog open={stale}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>This tab is in {workspaceName}</AlertDialogTitle>
          <AlertDialogDescription>
            You switched to {other ?? 'another workspace'} in another tab. Choose where to keep
            working, so nothing from this tab is saved to the wrong workspace.
            {clickDropped ? ' Your last click was not applied, so make it again after you choose.' : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <Button
            disabled={busy}
            onClick={() => window.location.assign(platformHref(pathname, '/home'))}
            variant="outline"
          >
            Open {other ?? 'the other workspace'}
          </Button>
          <Button disabled={busy} onClick={() => void stay()}>
            {busy ? 'Switching…' : `Keep working in ${workspaceName}`}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
