'use client'

import * as React from 'react'
import { useSearchParams } from 'next/navigation'
import { registerNavigationGuard } from '@/lib/platform/navigation-guard'
import { TRPCClientError } from '@trpc/client'
import { toast } from 'sonner'
import { templateStarter } from '@/lib/design/templates'
import { projectIdSchema } from '@/lib/projects/schema'
import {
  autosaveDesignAsProject,
  openProject,
  releaseDraft,
  saveProjectNow,
  startNewDesign,
  useProjectSession,
} from '@/lib/projects/session'
import { useTRPCClient } from '@/lib/trpc/react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { useCanSaveProjects } from '@/lib/platform/can-start-post'
import { useImageStore } from '@/lib/store'

/**
 * Drop `?start=` once handled, so a reload keeps the new work instead of
 * starting again. A null state lets the router see the change, so choosing
 * New → Screenshot again starts again.
 */
function clearStartParam(): void {
  const url = new URL(window.location.href)
  url.searchParams.delete('start')
  url.searchParams.delete('template')
  window.history.replaceState(null, '', url)
}

/** Long enough that a burst of edits, or a person about to name it themselves, comes first. */
const AUTOSAVE_AFTER_MS = 30_000

/**
 * Opens the project named by `?project=<id>` when the editor mounts, or
 * reopens the project that was open when the editor comes back into view,
 * so the canvas and the project never drift apart. `?start=new` (New →
 * Screenshot) saves and closes that project instead and starts a clean canvas,
 * or the template named by `&template=<id>`.
 * Leaving the editor saves what is pending.
 */
export function ProjectLoader() {
  const trpcClient = useTRPCClient()
  const startedRef = React.useRef(false)
  const startingRef = React.useRef(false)
  const [confirmStart, setConfirmStart] = React.useState(false)
  const searchParams = useSearchParams()
  const start = searchParams.get('start')
  const template = searchParams.get('template')
  const { status, error } = useProjectSession()

  React.useEffect(() => {
    if (status === 'error' || status === 'offline' || status === 'conflict') {
      toast.error('Your project has not been saved', {
        id: 'project-save-error',
        description: error ?? 'Open the project menu to resolve the problem.',
        duration: Infinity,
        action:
          status === 'conflict'
            ? undefined
            : {
                label: 'Retry',
                onClick: () => void saveProjectNow(),
              },
      })
    } else if (status === 'saved') {
      toast.dismiss('project-save-error')
    }
  }, [status, error])

  React.useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    const params = new URLSearchParams(window.location.search)
    // A new screenshot is started below, and must not reopen the last project first.
    if (params.get('start') === 'new') return
    const requested = params.get('project') ?? useProjectSession.getState().projectId
    if (!requested) {
      releaseDraft()
      return
    }
    const parsed = projectIdSchema.safeParse(requested)
    if (!parsed.success) {
      toast.error('Could not open the project', { description: 'The project link is not valid.' })
      return
    }
    openProject(trpcClient, parsed.data)
      .then((outcome) => {
        if (outcome === 'recovered') {
          toast.success('Recovered your unsaved changes', {
            description: 'They are being saved to the project now.',
          })
        }
      })
      .catch((error: unknown) => {
        const missing = error instanceof TRPCClientError && error.data?.code === 'NOT_FOUND'
        toast.error('Could not open the project', {
          description: missing
            ? 'It may have been deleted, or you may not have access to it.'
            : 'Check your connection, then reload the page to try again.',
        })
      })
  }, [trpcClient])

  const begin = React.useCallback(
    async (discardLocal: boolean) => {
      if (startingRef.current) return
      startingRef.current = true
      setConfirmStart(false)
      try {
        const design = template ? templateStarter(template) : undefined
        if (template && !design)
          toast.error('That template is no longer available', {
            description: 'A blank screenshot was started instead.',
          })
        const outcome = await startNewDesign(trpcClient, discardLocal, design)
        if (outcome === 'local-design') {
          setConfirmStart(true)
          return
        }
        clearStartParam()
        // The project's own save error stays on screen with its Retry.
        if (outcome === 'not-saved')
          toast.error('A new screenshot was not started', {
            description: 'Your project is still open because its last changes are not saved.',
          })
      } catch {
        clearStartParam()
        toast.error('Could not start a new screenshot', {
          description: 'Check your connection, then choose New → Screenshot again.',
        })
      } finally {
        startingRef.current = false
      }
    },
    [template, trpcClient]
  )

  React.useEffect(() => {
    if (start === 'new') void begin(false)
  }, [start, begin])

  // Work belongs to the workspace, not one browser: a design with content becomes a
  // project shortly after the last edit. The browser's copy covers the moments before.
  const canSave = useCanSaveProjects()
  const autosaveBlocked = React.useRef(false)
  const autosave = React.useCallback(async () => {
    if (!canSave || autosaveBlocked.current) return
    try {
      await autosaveDesignAsProject(trpcClient)
    } catch {
      // A plan limit or a lost connection: stop asking, and the browser's copy keeps the work.
      autosaveBlocked.current = true
      toast.info('Saved in this browser only', {
        description: 'Save it as a project to keep it in your workspace.',
        id: 'project-autosave',
      })
    }
  }, [canSave, trpcClient])
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = useImageStore.subscribe(() => {
      clearTimeout(timer)
      if (!useProjectSession.getState().projectId)
        timer = setTimeout(() => void autosave(), AUTOSAVE_AFTER_MS)
    })
    return () => {
      clearTimeout(timer)
      stop()
    }
  }, [autosave])

  React.useEffect(
    () =>
      registerNavigationGuard(async () => {
        if (!useProjectSession.getState().projectId) {
          await autosave()
          return
        }
        await saveProjectNow()
        if (useProjectSession.getState().status !== 'saved')
          throw new Error('Save the screenshot project before leaving.')
      }, true),
    [autosave]
  )
  React.useEffect(() => () => void saveProjectNow(), [])

  return (
    <AlertDialog open={confirmStart}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Start a new screenshot?</AlertDialogTitle>
          <AlertDialogDescription>
            The design on the canvas is saved only in this browser, not to the workspace. Starting a
            new screenshot replaces it. To keep it, choose Keep editing, then Save as project.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            onClick={() => {
              setConfirmStart(false)
              clearStartParam()
            }}
            variant="outline"
          >
            Keep editing
          </Button>
          <Button onClick={() => void begin(true)} variant="destructive">
            Replace with a new screenshot
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
