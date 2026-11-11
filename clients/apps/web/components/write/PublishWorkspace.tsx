'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { XIcon } from '@phosphor-icons/react/dist/ssr/X'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { DraftSettingsDrawer } from '@/components/drafts/DraftSettingsDrawer'
import { Button } from '@/components/ui/button'
import { PendingDraftInput } from './pending-draft'
import { useWrite, type WriteLibrary, WriteProvider } from './write-context'

/**
 * Publishing as a workspace over the screenshot editor.
 *
 * The screenshot editor opens a draft at its own address (`/publish/<id>`);
 * Next intercepts that navigation and renders the same composer here, at 90%
 * of the viewport, while the design stays mounted underneath with its
 * selection and undo history. Refreshing shows the full Publish page for the
 * same draft, so nothing about the post lives only in this overlay.
 *
 * Not a Radix *modal*: that sets `pointer-events: none` on the body, and the
 * composer's slash menu, mentions and emoji open in Ariakit portals on the
 * body, which would stop taking clicks. The page underneath is made `inert`
 * instead, which keeps it out of the tab order, the pointer and assistive
 * technology just as a modal would.
 */
export function PublishWorkspace({
  activeId,
  canEdit,
  canManageSets,
  canPublish,
  canReview,
  children,
  data,
}: {
  activeId: string
  canEdit: boolean
  canManageSets: boolean
  canPublish: boolean
  canReview: boolean
  children: React.ReactNode
  data: WriteLibrary
}) {
  // Next keeps a parallel slot's last page through a soft navigation the slot
  // has no page for, such as an attachment's "Edit in editor" link to
  // `/editor?asset=…`. The workspace shows only at a draft's address.
  const pathname = usePathname()
  if (!DRAFT_PATH.test(pathname)) return null
  return (
    <WriteProvider
      activeId={activeId}
      canEdit={canEdit}
      canManageSets={canManageSets}
      canPublish={canPublish}
      canReview={canReview}
      data={data}
    >
      <WorkspaceDialog>{children}</WorkspaceDialog>
      {/* The composer opens its profile's settings over itself (?settings=scheduling). */}
      {data.activeSet ? (
        <DraftSettingsDrawer
          advancedScheduling={data.advancedScheduling}
          canManage={canManageSets}
          socialSetId={data.activeSet.id}
        />
      ) : null}
    </WriteProvider>
  )
}

/** A draft's address, with or without a locale prefix. */
const DRAFT_PATH = /\/publish\/[^/]+$/

/** Whether Escape belongs to something being typed or picked, not to the workspace. */
function escapeIsTaken(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        '[contenteditable="true"], input, textarea, select, [role="combobox"], [role="listbox"], [role="menu"]'
      )
    )
  )
}

/**
 * Step back through history until the address is no longer a draft's.
 *
 * The workspace only opens by a push from the editor, and every draft it then
 * moves to (scheduling opens the next one by default) is another entry on top,
 * so the first entry that is not a draft is the design it was opened over.
 * Going back restores that entry as it was, which navigating to the editor's
 * address again does not: Next keeps the slot's last page through that.
 */
function backToDesign(steps = 50): void {
  const onPop = () => {
    if (DRAFT_PATH.test(window.location.pathname) && --steps > 0) window.history.back()
    else window.removeEventListener('popstate', onPop)
  }
  window.addEventListener('popstate', onPop)
  window.history.back()
}

function WorkspaceDialog({ children }: { children: React.ReactNode }) {
  const { beforeLeaveRef } = useWrite()
  const closing = React.useRef(false)

  // Everything behind the workspace leaves the tab order and the pointer.
  React.useEffect(() => {
    const shell = document.querySelector<HTMLElement>('[data-platform-shell]')
    if (!shell) return
    shell.inert = true
    return () => {
      shell.inert = false
    }
  }, [])

  // The composer saves as it goes; leaving waits for the last edit to land and
  // stays open if it cannot, which the composer reports itself.
  const close = async () => {
    if (closing.current) return
    closing.current = true
    try {
      await beforeLeaveRef.current?.()
      backToDesign()
    } catch {
      closing.current = false
    }
  }

  return (
    <DialogPrimitive.Root modal={false} onOpenChange={(open) => !open && void close()} open>
      <DialogPrimitive.Portal>
        <div aria-hidden className="fixed inset-0 z-50 bg-background/70 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="platform-overlay fixed top-1/2 left-1/2 z-50 flex h-[90dvh] max-h-[90dvh] w-[90vw] max-w-none -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-foreground/10 bg-card shadow-2xl max-md:h-[96dvh] max-md:max-h-[96dvh] max-md:w-[96vw]"
          data-slot="dialog-content"
          data-testid="publish-workspace"
          // Popups the composer opens elsewhere on the page (its menus, Plate's
          // slash menu, dialogs over it) are not a reason to close.
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (escapeIsTaken(event.target)) event.preventDefault()
          }}
        >
          <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-4">
            <DialogPrimitive.Title className="text-ui-lg font-medium text-foreground">
              Publish
            </DialogPrimitive.Title>
            <span className="truncate text-xs text-muted-foreground">
              Your design stays open behind this; close to keep editing it.
            </span>
            <Button
              aria-label="Close Publish"
              className="ml-auto size-8 px-0"
              onClick={() => void close()}
              size="sm"
              type="button"
              variant="ghost"
            >
              <XIcon aria-hidden className="size-4" />
            </Button>
          </header>
          {/* The composer scrolls its draft and keeps its side column in view within this. */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <main className="relative min-h-0 flex-1 scroll-pb-32 overflow-y-auto">{children}</main>
            {/* Save draft & new opens the next post here, over the composer it follows. */}
            <PendingDraftInput variant="write" />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
