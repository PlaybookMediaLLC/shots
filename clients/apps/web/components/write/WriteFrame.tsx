'use client'

import { useWriteRouter } from '@/components/write/write-context'

import * as React from 'react'
import dynamic from 'next/dynamic'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { WorkspaceNav } from '@/components/plan/WorkspaceNav'
import { createWritingDraft } from './pending-draft'
import { cn } from '@/lib/utils'
import { WriteRail } from './library'
import { type Shortcut, useKeys, useShortcuts } from './shortcuts'
import { draftHref, useWrite, type WriteLibrary, WriteProvider } from './write-context'

// The palette loads on first use: it is not part of reading a draft.
const CommandPalette = dynamic(() => import('./CommandPalette'), { ssr: false })

/** The shortcuts the reference lists, with where each applies. */
export const SHORTCUT_REFERENCE: {
  group: string
  items: (Pick<Shortcut, 'alt' | 'key' | 'mod' | 'shift'> & { label: string })[]
}[] = [
  {
    group: 'Everywhere in Write',
    items: [
      { key: 'k', label: 'Search and commands', mod: true },
      { key: '/', label: 'Show or hide the drafts list', mod: true },
      { key: '1', label: 'Write', mod: true, shift: true },
      { key: '2', label: 'Calendar', mod: true, shift: true },
      { key: '.', label: 'New draft', mod: true },
      { alt: true, key: 'arrowdown', label: 'Next draft', mod: true },
      { alt: true, key: 'arrowup', label: 'Previous draft', mod: true },
      { key: '/', label: 'This list of shortcuts', mod: true, shift: true },
    ],
  },
  {
    group: 'In a draft',
    items: [
      { key: '\\', label: 'Draft details', mod: true },
      { key: 'p', label: 'Pin or unpin', mod: true, shift: true },
      { alt: true, key: 's', label: 'Share', mod: true },
      {
        key: 'enter',
        label: 'Open the publish review (never publishes by itself)',
        mod: true,
        shift: true,
      },
      {
        alt: true,
        key: 'enter',
        label: 'Schedule at the next free slot (opens the review)',
        mod: true,
      },
      { key: 'enter', label: 'Add a post', mod: true },
      { alt: true, key: 'arrowup', label: 'Move the post up' },
      { alt: true, key: 'arrowdown', label: 'Move the post down' },
      { key: 'i', label: 'Add media', mod: true, shift: true },
      { key: '.', label: 'Emoji', mod: true, shift: true },
      { key: 'f', label: 'Focus mode', mod: true, shift: true },
      { key: 'h', label: 'Display mode: compact or comfortable', mod: true, shift: true },
      { key: 'm', label: 'Comment on the selection', mod: true, shift: true },
      { key: 'j', label: 'Writing assistant', mod: true },
      { key: 'e', label: 'Rewrite with AI', mod: true, shift: true },
      { key: 'v', label: 'Preview', mod: true, shift: true },
    ],
  },
]

/**
 * The Write frame: the library on the left and the open draft, or a hint,
 * filling the rest. On a phone the library is the page until a draft opens,
 * then a drawer; the draft's identity and save state stay visible.
 */
export function WriteFrame({
  activeId,
  campaignsEnabled = false,
  canEdit,
  canManageSets,
  canPublish,
  canReview,
  children,
  data,
  section = 'drafts',
}: {
  activeId?: string
  /** Campaigns are usable here: the rollout and a paid plan. */
  campaignsEnabled?: boolean
  canEdit: boolean
  canManageSets: boolean
  canPublish: boolean
  canReview: boolean
  children: React.ReactNode
  data: WriteLibrary
  /** The Publish tab this page belongs to. */
  section?: 'analyze' | 'drafts'
}) {
  return (
    <WriteProvider
      activeId={activeId}
      canEdit={canEdit}
      canManageSets={canManageSets}
      canPublish={canPublish}
      canReview={canReview}
      data={data}
    >
      <FrameLayout activeId={activeId} campaignsEnabled={campaignsEnabled} section={section}>
        {children}
      </FrameLayout>
    </WriteProvider>
  )
}

/** Opens the drafts drawer on a phone, from anywhere in the frame. */
export const DraftsDrawerContext = React.createContext<() => void>(() => {})

function FrameLayout({
  activeId,
  campaignsEnabled,
  children,
  section,
}: {
  activeId?: string
  campaignsEnabled: boolean
  children: React.ReactNode
  section: 'analyze' | 'drafts'
}) {
  const router = useWriteRouter()
  const keys = useKeys()
  const { beforeLeaveRef, canEdit, data } = useWrite()
  const [railOpen, setRailOpen] = React.useState(true)
  const [drawer, setDrawer] = React.useState(false)
  const [palette, setPalette] = React.useState(false)
  const [reference, setReference] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [keyboardInset, setKeyboardInset] = React.useState(0)
  React.useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const resize = () =>
      setKeyboardInset(Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop))
    resize()
    viewport.addEventListener('resize', resize)
    viewport.addEventListener('scroll', resize)
    return () => {
      viewport.removeEventListener('resize', resize)
      viewport.removeEventListener('scroll', resize)
    }
  }, [])
  const newDraft = async () => {
    if (!canEdit || creating) return
    setCreating(true)
    try {
      await createWritingDraft(
        {
          socialSetId: data.activeSet?.id,
          tagIds: data.experiments.tags && data.query.tag ? [data.query.tag] : undefined,
        },
        (id) => router.push(draftHref(id, data.activeSet?.id)),
        beforeLeaveRef.current ?? undefined
      )
    } finally {
      setCreating(false)
    }
  }
  const launcher = React.useRef<HTMLElement | null>(null)
  const launcherRange = React.useRef<Range | null>(null)
  const launcherScroll = React.useRef<{ element: HTMLElement; top: number; left: number } | null>(
    null
  )
  const rememberLauncher = React.useCallback(() => {
    launcher.current = document.activeElement as HTMLElement | null
    const selection = window.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    launcherRange.current =
      range && launcher.current?.contains(range.commonAncestorContainer) ? range.cloneRange() : null
    const element = launcher.current?.closest('main')
    launcherScroll.current = element
      ? { element, top: element.scrollTop, left: element.scrollLeft }
      : null
  }, [])
  const open = (setter: (value: boolean) => void) => {
    rememberLauncher()
    setter(true)
  }
  React.useEffect(() => {
    const show = () => {
      rememberLauncher()
      setPalette(true)
    }
    window.addEventListener('shots:search-write', show)
    return () => window.removeEventListener('shots:search-write', show)
  }, [rememberLauncher])
  const step = (delta: number) => {
    const ids = data.library.map((draft) => draft.id)
    const index = activeId ? ids.indexOf(activeId) : -1
    const next = ids[Math.min(ids.length - 1, Math.max(0, index + delta))]
    if (next && next !== activeId) router.push(draftHref(next, data.activeSet?.id))
  }
  useShortcuts([
    {
      key: '/',
      label: 'Drafts list',
      mod: true,
      run: () => setRailOpen((current) => !current),
      inEditor: true,
    },
    {
      key: '!',
      label: 'Write',
      mod: true,
      run: () => router.push(`/write${data.activeSet ? `?set=${data.activeSet.id}` : ''}`),
      shift: true,
      inEditor: true,
    },
    {
      key: '1',
      label: 'Write',
      mod: true,
      run: () => router.push(`/write${data.activeSet ? `?set=${data.activeSet.id}` : ''}`),
      shift: true,
      inEditor: true,
    },
    {
      key: '@',
      label: 'Calendar',
      mod: true,
      run: () => router.push(`/write/plan${data.activeSet ? `?set=${data.activeSet.id}` : ''}`),
      shift: true,
      inEditor: true,
    },
    {
      key: '2',
      label: 'Calendar',
      mod: true,
      run: () => router.push(`/write/plan${data.activeSet ? `?set=${data.activeSet.id}` : ''}`),
      shift: true,
      inEditor: true,
    },
    {
      key: '.',
      label: 'New draft',
      mod: true,
      inEditor: true,
      run: () => void newDraft(),
    },
    {
      alt: true,
      key: 'arrowdown',
      label: 'Next draft',
      mod: true,
      run: () => step(1),
      inEditor: true,
    },
    {
      alt: true,
      key: 'arrowup',
      label: 'Previous draft',
      mod: true,
      run: () => step(-1),
      inEditor: true,
    },
    {
      key: '?',
      label: 'Shortcuts',
      mod: true,
      run: () => open(setReference),
      shift: true,
      inEditor: true,
    },
    {
      key: '/',
      label: 'Shortcuts',
      mod: true,
      run: () => open(setReference),
      shift: true,
      inEditor: true,
    },
  ])
  const restoreFocus = () => {
    // Focusing a contenteditable alone moves its native caret to the start.
    // Restore its range as well, while leaving the surrounding scroll in place.
    setTimeout(() => {
      if (!launcher.current?.isConnected) return
      launcher.current.focus({ preventScroll: true })
      const range = launcherRange.current
      if (range?.startContainer.isConnected && range.endContainer.isConnected) {
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
      const scroll = launcherScroll.current
      if (scroll?.element.isConnected) scroll.element.scrollTo(scroll.left, scroll.top)
    }, 0)
  }
  React.useEffect(() => {
    const timer = setTimeout(() => {
      void import('@/components/drafts/DraftEditor')
    }, 0)
    return () => clearTimeout(timer)
  }, [])
  return (
    <DraftsDrawerContext.Provider value={() => setDrawer(true)}>
      <div
        className="flex h-[calc(100dvh-3.5rem)] min-h-0 flex-col md:h-[calc(100vh-1rem-2px)]"
        data-testid="write-frame"
      >
        {/* On a phone an open draft keeps the whole screen; its header leads back to the list. */}
        <div className={cn(activeId && section === 'drafts' && 'hidden md:block')}>
          <WorkspaceNav
            active={section}
            campaigns={campaignsEnabled}
            scope={data.activeSet ? `?set=${data.activeSet.id}` : ''}
          />
        </div>
        <div className="flex min-h-0 flex-1">
          <div
            data-write-rail-column
            className={cn(
              'w-full shrink-0 border-border md:w-80 md:border-r',
              activeId ? 'hidden' : 'block',
              railOpen ? 'md:block' : 'md:hidden'
            )}
          >
            <WriteRail key={data.activeSet?.id ?? 'none'} />
          </div>
          <main
            className={cn(
              // Focused controls scroll clear of the floating formatting bar.
              'relative min-w-0 flex-1 scroll-pb-32 overflow-y-auto',
              !activeId && 'hidden md:block'
            )}
          >
            {children}
          </main>
        </div>
      </div>
      {canEdit ? (
        <Button
          aria-label="New draft"
          className="fixed right-4 z-20 size-11 rounded-full shadow-lg md:hidden"
          data-testid="mobile-new-draft"
          disabled={creating}
          onClick={() => void newDraft()}
          style={{
            bottom: `calc(${keyboardInset + (activeId ? 84 : 20)}px + env(safe-area-inset-bottom))`,
          }}
          type="button"
        >
          <span aria-hidden className="text-2xl leading-none">
            +
          </span>
        </Button>
      ) : null}
      <Sheet onOpenChange={setDrawer} open={drawer}>
        <SheetContent className="w-full pt-10 sm:max-w-sm" side="left">
          <SheetHeader className="sr-only">
            <SheetTitle>Drafts</SheetTitle>
            <SheetDescription>The drafts of this brand.</SheetDescription>
          </SheetHeader>
          <WriteRail key={data.activeSet?.id ?? 'none'} />
        </SheetContent>
      </Sheet>
      {palette ? (
        <CommandPalette
          campaignsEnabled={campaignsEnabled}
          onClose={() => {
            setPalette(false)
            restoreFocus()
          }}
          onShortcuts={() => setReference(true)}
        />
      ) : null}
      <Dialog onOpenChange={setReference} open={reference}>
        <DialogContent
          className="max-h-[85dvh] max-w-lg overflow-y-auto"
          // Restore once the focus trap has released, not while it still holds focus.
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            restoreFocus()
          }}
        >
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>
              Shortcuts wait while you type in a field or a dialog is open, except the ones meant
              for writing. Publishing shortcuts only open the review.
            </DialogDescription>
          </DialogHeader>
          {SHORTCUT_REFERENCE.map((group) => (
            <section key={group.group}>
              <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {group.group}
              </h3>
              <dl
                className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm"
                data-testid="shortcut-reference"
              >
                {group.items.map((item) => (
                  <React.Fragment key={`${group.group}-${item.label}`}>
                    <dt className="text-foreground">{item.label}</dt>
                    <dd>
                      <kbd className="rounded border border-border bg-foreground/[0.04] px-1.5 py-0.5 text-xs text-foreground">
                        {keys.label(item)}
                      </kbd>
                    </dd>
                  </React.Fragment>
                ))}
              </dl>
            </section>
          ))}
        </DialogContent>
      </Dialog>
    </DraftsDrawerContext.Provider>
  )
}

/** The phone's way back to the drafts list from an open draft. */
export function DraftsDrawerButton() {
  const openDrawer = React.useContext(DraftsDrawerContext)
  return (
    <Button
      aria-label="Drafts"
      className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground md:hidden"
      onClick={openDrawer}
      size={null}
      type="button"
      variant="custom"
    >
      ☰
    </Button>
  )
}
