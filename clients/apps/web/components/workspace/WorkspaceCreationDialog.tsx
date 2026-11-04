'use client'

import { prepareWorkspaceSwitch } from '@/lib/platform/navigation-guard'
import { announceSessionChange } from '@/lib/auth/client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import type { WorkspaceCreationResult } from 'screenshot-studio-backend-sdk'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTRPCClient } from '@/lib/trpc/react'
import { settingsErrorMessage } from '@/lib/settings/client'
import { workspaceNameSchema } from '@/lib/workspace/input-schemas'
import { TimeZonePicker } from '@/components/settings/TimeZonePicker'
import { browserTimeZone } from '@/lib/time-zones'
import {
  isTerminalCreationError,
  newWorkspaceCreationAttempt,
  readWorkspaceCreationAttempt,
  workspaceCreationStorageKey,
} from '@/lib/workspace/creation-attempt'

/** Creates a team without replacing the current page or selecting another tenant. */
export function WorkspaceCreationDialog({
  email,
  userId,
  onClose,
  onCreated,
  returnFocusRef,
}: {
  email: string
  userId: string
  onClose: () => void
  onCreated?: (organization: WorkspaceCreationResult['organization']) => void
  returnFocusRef: RefObject<HTMLButtonElement | null>
}) {
  const client = useTRPCClient()
  const [recovery] = useState(() => readWorkspaceCreationAttempt(userId))
  const [recoveryBlocked, setRecoveryBlocked] = useState(recovery.status === 'unavailable')
  const [attempt, setAttempt] = useState(recovery.status === 'pending' ? recovery.attempt : null)
  const [name, setName] = useState(() => attempt?.input.name ?? '')
  const [timeZone, setTimeZone] = useState(() => attempt?.input.timeZone ?? 'UTC')
  const [created, setCreated] = useState<WorkspaceCreationResult['organization'] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const nameInput = useRef<HTMLInputElement>(null)
  const parsed = workspaceNameSchema.safeParse(name)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      controller.current?.abort()
    }
  }, [])
  useEffect(() => {
    if (!attempt) setTimeZone(browserTimeZone())
  }, [attempt])

  const close = () => {
    if (!pending.current) onClose()
  }

  async function create() {
    if (!parsed.success || pending.current || recoveryBlocked) return
    const request = attempt ?? newWorkspaceCreationAttempt(parsed.data, timeZone)
    // A reload must reconcile this intent instead of issuing a fresh UUID.
    try {
      sessionStorage.setItem(workspaceCreationStorageKey(userId), JSON.stringify(request))
    } catch {
      setError(
        'This browser could not save the creation request. Allow site storage and try again.'
      )
      return
    }
    setAttempt(request)
    pending.current = true
    setBusy(true)
    setError(null)
    controller.current = new AbortController()
    const timeout = window.setTimeout(() => controller.current?.abort(), 30_000)
    try {
      const result = await client.workspace.create.mutate(request.input, {
        signal: controller.current.signal,
      })
      if (!mounted.current) return
      setCreated(result.organization)
      try {
        sessionStorage.removeItem(workspaceCreationStorageKey(userId))
      } catch {
        /* A future open safely replays the saved request. */
      }
      onCreated?.(result.organization)
    } catch (cause) {
      if (!mounted.current) return
      const rejected = isTerminalCreationError(cause)
      setRecoveryBlocked(rejected)
      setError(
        rejected
          ? settingsErrorMessage(cause)
          : `${settingsErrorMessage(cause)} Retry this request to confirm whether the workspace was created.`
      )
    } finally {
      window.clearTimeout(timeout)
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  async function openWorkspace(path: string) {
    if (!created || pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      await prepareWorkspaceSwitch()
      await client.workspace.setActive.mutate({ organizationId: created.id })
      announceSessionChange()
      if (!mounted.current) return
      window.location.assign(path)
    } catch (cause) {
      if (!mounted.current) return
      setError(settingsErrorMessage(cause))
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto"
        showCloseButton={!busy}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          nameInput.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          returnFocusRef.current?.focus()
        }}
        onEscapeKeyDown={(event) => {
          if (pending.current) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (pending.current) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{created ? 'Workspace created' : 'Create workspace'}</DialogTitle>
          <DialogDescription>
            {created
              ? `${created.name} is ready. Your current workspace is still selected.`
              : 'Share publishing brands with colleagues or clients for writing, review, and scheduling. Each workspace has its own members and plan.'}
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="grid gap-3">
            <Button disabled={busy} onClick={() => void openWorkspace('/workspace/channels')}>
              Connect social accounts
            </Button>
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => void openWorkspace('/workspace/members')}
            >
              Invite members
            </Button>
            <Button disabled aria-describedby="workspace-move-unavailable" variant="outline">
              Move a personal publishing brand
            </Button>
            <p id="workspace-move-unavailable" className="text-sm text-muted-foreground">
              Moving existing sets between workspaces is not available yet.
            </p>
            <p className="text-sm text-muted-foreground">
              Choose this workspace&apos;s plan before publishing or adding teammates.
            </p>
            <Button
              disabled={busy}
              variant="ghost"
              onClick={() => void openWorkspace('/workspace/billing')}
            >
              Choose a plan
            </Button>
          </div>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              void create()
            }}
          >
            <a
              className="w-fit text-sm underline underline-offset-4"
              href="/workspace/roles"
              target="_blank"
              rel="noreferrer"
            >
              Learn about team roles
            </a>
            {recoveryBlocked ? (
              <div className="grid gap-2" role="alert">
                <p className="text-sm text-destructive">
                  {attempt
                    ? 'This creation request was rejected. Check your workspace list before discarding it and starting another request.'
                    : 'A saved creation request could not be read. It may already have created a workspace. Check your workspace list before discarding it.'}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    try {
                      sessionStorage.removeItem(workspaceCreationStorageKey(userId))
                      setRecoveryBlocked(false)
                      setAttempt(null)
                      setName('')
                      setError(null)
                    } catch {
                      setError('Allow site storage, then reopen this dialog.')
                    }
                  }}
                >
                  {attempt ? 'Discard failed request' : 'Discard unreadable request'}
                </Button>
              </div>
            ) : null}
            <div className="grid gap-2">
              <Label htmlFor="workspace-creation-name">Workspace name</Label>
              <Input
                ref={nameInput}
                id="workspace-creation-name"
                placeholder="Team, project, or client name"
                value={name}
                readOnly={attempt !== null}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
                aria-describedby="workspace-creation-owner workspace-creation-validation"
                aria-invalid={name.length > 0 && !parsed.success}
              />
              <p id="workspace-creation-owner" className="text-sm text-muted-foreground">
                You will be its owner, as {email}.
              </p>
              <p id="workspace-creation-validation" className="text-sm text-muted-foreground">
                {attempt
                  ? recoveryBlocked
                    ? 'Discard this rejected request to enter a new workspace name.'
                    : 'A submitted request is waiting for confirmation. Retry it to recover the same workspace.'
                  : name.length > 0 && !parsed.success
                    ? parsed.error.issues[0]?.message
                    : 'Use 2–100 characters. Different workspaces may share a name.'}
              </p>
            </div>
            <TimeZonePicker
              disabled={busy || attempt !== null}
              label="Workspace time zone"
              onChange={setTimeZone}
              value={timeZone}
            />
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy} onClick={close}>
                {attempt ? 'Close' : 'Cancel'}
              </Button>
              <Button type="submit" disabled={!parsed.success || busy || recoveryBlocked}>
                {busy ? 'Confirming…' : attempt ? 'Retry creation' : 'Create workspace'}
              </Button>
            </DialogFooter>
          </form>
        )}
        {created ? (
          <>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={close}>
                Stay on this page
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
