'use client'

import * as React from 'react'
import { TRPCClientError } from '@trpc/client'
import { toast } from 'sonner'
import type { StoreApi } from 'zustand/vanilla'
import { Button } from '@/components/ui/button'
import { useHydratedSession } from '@/lib/auth/client'
import { createVersion } from '@/lib/store-screenshots/persistence/projects'
import {
  documentHash,
  pullStoreProject,
  pushStoreProject,
  readWorkspaceLink,
  writeWorkspaceLink,
  type WorkspaceLink,
} from '@/lib/store-screenshots/workspace'
import { useTRPCClient } from '@/lib/trpc/react'
import type { EditorState } from './editor-store'

/**
 * Workspace autosave for one open project. Nothing leaves this browser until
 * the user chooses "Save to workspace"; from then on every change is written
 * there too, one write at a time, each based on the revision this browser
 * last saw. A newer save from another device stops the sync and asks which
 * copy to keep; this browser's copy is never discarded without a version.
 */

const SYNC_DELAY_MS = 3000

/** Where the open project stands in the workspace. */
export type WorkspaceSyncStatus = 'off' | 'checking' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict'

const errorCode = (cause: unknown) => (cause instanceof TRPCClientError ? cause.data?.code : undefined)
const message = (cause: unknown) => (cause instanceof Error ? cause.message : undefined)

/** Workspace sync controller for one open project. */
export function useWorkspaceSync(store: StoreApi<EditorState>) {
  const client = useTRPCClient()
  const { data: session } = useHydratedSession()
  const organizationId = session?.session.activeOrganizationId ?? null
  const [status, setStatusState] = React.useState<WorkspaceSyncStatus>('off')
  const statusRef = React.useRef<WorkspaceSyncStatus>('off')
  const linkRef = React.useRef<WorkspaceLink | null>(null)
  const chainRef = React.useRef<Promise<void>>(Promise.resolve())
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const uploadsRef = React.useRef(new Map<string, string>())

  const setStatus = React.useCallback((next: WorkspaceSyncStatus) => {
    statusRef.current = next
    setStatusState(next)
  }, [])

  /** Run one step after the ones before it, so writes never overtake each other. */
  const queue = React.useCallback((step: () => Promise<void>) => {
    chainRef.current = chainRef.current.then(step, step)
    return chainRef.current
  }, [])

  const link = React.useCallback(
    async (projectId: string, next: WorkspaceLink | null) => {
      linkRef.current = next
      if (organizationId) await writeWorkspaceLink(organizationId, projectId, next)
    },
    [organizationId]
  )

  /** Replace the open document with the workspace copy, keeping this browser's copy as a version. */
  const adoptRemote = React.useCallback(
    async (keepLocal: boolean) => {
      const local = store.getState().document
      const pulled = await pullStoreProject(client, local.id)
      if (keepLocal) await createVersion(local, 'Before the workspace version', null)
      store.getState().replaceDocument(pulled.document, { resetHistory: true })
      await link(local.id, pulled.link)
      setStatus('saved')
    },
    [client, link, setStatus, store]
  )

  const push = React.useCallback(
    (first = false) =>
      queue(async () => {
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = null
        const current = linkRef.current
        if ((!first && !current) || statusRef.current === 'conflict') return
        const document = store.getState().document
        if (current && (await documentHash(document)) === current.hash) {
          setStatus('saved')
          return
        }
        setStatus('saving')
        try {
          await link(document.id, await pushStoreProject(client, document, current, uploadsRef.current))
          setStatus(store.getState().document === document ? 'saved' : 'pending')
        } catch (cause) {
          if (errorCode(cause) === 'CONFLICT') {
            setStatus('conflict')
            return
          }
          setStatus(first ? 'off' : 'error')
          toast.error('Could not save to your workspace', {
            description: `${message(cause) ?? 'Try again.'} The project is still saved on this browser.`,
          })
        }
      }),
    [client, link, queue, setStatus, store]
  )

  // Compare with the workspace copy on open, and again whenever the studio is shown.
  React.useEffect(() => {
    if (!organizationId) return
    void queue(async () => {
      const document = store.getState().document
      const current = await readWorkspaceLink(organizationId, document.id)
      linkRef.current = current
      if (!current) {
        setStatus('off')
        return
      }
      setStatus('checking')
      try {
        const remote = await client.storeProject.get.query({ projectId: document.id })
        const edited = (await documentHash(store.getState().document)) !== current.hash
        if (remote.revision === current.revision) {
          setStatus(edited ? 'pending' : 'saved')
          if (edited) timerRef.current = setTimeout(() => void push(), SYNC_DELAY_MS)
        } else if (!edited) {
          await adoptRemote(false)
          toast('Updated with changes saved on another device')
        } else {
          setStatus('conflict')
        }
      } catch (cause) {
        if (errorCode(cause) === 'NOT_FOUND') {
          await link(document.id, null)
          setStatus('off')
          toast('This project is no longer in your workspace', {
            description: 'It is still on this browser. Save it to the workspace again to share it.',
          })
          return
        }
        setStatus('error')
      }
    })
  }, [adoptRemote, client, link, organizationId, push, queue, setStatus, store])

  React.useEffect(() => {
    let previous = store.getState().document
    const unsubscribe = store.subscribe((state) => {
      if (state.document === previous) return
      previous = state.document
      if (!linkRef.current || statusRef.current === 'conflict' || statusRef.current === 'checking') return
      setStatus('pending')
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => void push(), SYNC_DELAY_MS)
    })
    return () => {
      unsubscribe()
      // Leaving the project or the studio writes what is waiting instead of dropping it.
      if (timerRef.current) void push()
    }
  }, [push, setStatus, store])

  return {
    /** Null outside a workspace, where there is nothing to save to. */
    status: organizationId ? status : null,
    save: () => void push(true),
    retry: () => {
      if (statusRef.current === 'error') setStatus('pending')
      void push()
    },
    /** Write this browser's copy over the newer workspace one. */
    keepMine: () =>
      void queue(async () => {
        try {
          const remote = await client.storeProject.get.query({ projectId: store.getState().document.id })
          // An empty hash makes the next write go out even when nothing changed since the conflict.
          linkRef.current = {
            revision: remote.revision,
            hash: '',
            assetMap: linkRef.current?.assetMap ?? remote.document.assetMap,
          }
          setStatus('pending')
        } catch (cause) {
          setStatus('conflict')
          toast.error('Could not reach your workspace', { description: message(cause) })
        }
      }).then(() => (statusRef.current === 'pending' ? push() : undefined)),
    /** Open the workspace copy; this browser's copy is kept in Versions. */
    loadTheirs: () =>
      void queue(async () => {
        try {
          await adoptRemote(true)
        } catch (cause) {
          toast.error('Could not load the workspace version', { description: message(cause) })
        }
      }),
  }
}

/** The workspace half of the header's save status. */
export function WorkspaceSaveStatus({ sync }: { sync: ReturnType<typeof useWorkspaceSync> }) {
  const button = 'h-7 rounded-md border border-foreground/15 px-2 text-[11px]'
  if (!sync.status || sync.status === 'checking') return null
  if (sync.status === 'off')
    return (
      <Button variant="custom" size={null} type="button" onClick={sync.save} className={button}>
        Save to workspace
      </Button>
    )
  if (sync.status === 'conflict')
    return (
      <span className="flex items-center gap-1">
        <span role="status" className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
          Changed on another device
        </span>
        <Button variant="custom" size={null} type="button" onClick={sync.loadTheirs} className={button}>
          Load workspace version
        </Button>
        <Button variant="custom" size={null} type="button" onClick={sync.keepMine} className="h-7 rounded-md bg-foreground px-2 text-[11px] text-background">
          Keep mine
        </Button>
      </span>
    )
  return (
    <span className="flex items-center gap-1">
      <span role="status" aria-live="polite" className="shrink-0 px-1.5 py-0.5 text-[10px] text-muted-foreground">
        {sync.status === 'saved' ? 'Saved to workspace' : sync.status === 'error' ? 'Not saved to workspace' : 'Saving to workspace…'}
      </span>
      {sync.status === 'error' ? (
        <Button variant="custom" size={null} type="button" onClick={sync.retry} className={button}>
          Retry
        </Button>
      ) : null}
    </span>
  )
}
