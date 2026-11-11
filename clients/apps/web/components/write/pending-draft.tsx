'use client'

import * as React from 'react'
import dynamic from 'next/dynamic'
import { usePathname, useRouter } from 'next/navigation'
import { draftsApi } from '@/lib/content-drafts/client'
import { draftAssetNode } from '@/lib/platform/asset-handoff'
import type { DraftChannel } from '@/lib/write/document'
import { importedBody } from '@/lib/write/import-text'
import { pastePieces } from '@/lib/write/paste-split'
import { seriesTitle } from '@/lib/write/series'
import { postBreak } from '@/lib/write/versions'
import { PasteSplit, type PasteChoice } from './paste-split'
import { prepareWorkspaceSwitch } from '@/lib/platform/navigation-guard'
import { platformHref } from '@/lib/platform/navigation'
import { isPlanRefusal } from '@/lib/api/platform-errors'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { POST_COLUMN } from '@/components/drafts/layout'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { platformCaptionLength } from '@/lib/content-drafts/serialize'
import { CAPABILITIES } from '@/lib/write/capabilities'
import { cn } from '@/lib/utils'
import { DestinationSummary, type Destination } from './destination-summary'

const LibraryAssetPicker = dynamic(
  () =>
    import('@/components/platform-hub/LibraryAssetPicker').then(
      (module) => module.LibraryAssetPicker
    ),
  { ssr: false }
)

type PendingDraft = {
  id?: string
  text: string
  error?: string
  planRequired?: boolean
  /**
   * A paste that separates into pieces, awaiting the writer's choice. While
   * it is set nothing is created: the choice decides what to create.
   */
  pieces?: string[]
  /** Nothing has been saved: the draft is made by the first word or attachment. */
  waiting?: boolean
  /** The platform the post's text and pasted pieces are counted for. */
  channel?: DraftChannel
  /** The accounts the post will publish to; unset when the brand's defaults decide. */
  destinations?: readonly Destination[]
}
let pending: PendingDraft | null = null
/** Attach media to a post still waiting to be made, and make it. */
let attachToWaiting: ((nodes: ReturnType<typeof draftAssetNode>[]) => void) | null = null
/** Act on a paste the writer has separated into pieces. */
let resolvePaste: ((choice: PasteChoice, seriesName: string) => Promise<void>) | null = null
/** Open the library's series scheduler on drafts just created; set while the box is mounted. */
let navigateToSeries: (ids: string[]) => void = () => undefined
let retry: (() => Promise<void>) | null = null
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
/** What the post is written for, carried into a value that replaces the current one. */
const shown = () => ({ channel: pending?.channel, destinations: pending?.destinations })
function update(value: PendingDraft | null) {
  pending = value
  listeners.forEach((listener) => listener())
}

/** Keep typing in a native field until the new draft's collaboration editor is ready. */
export async function createWritingDraft(
  input: Parameters<typeof draftsApi.create>[0],
  navigate: (id: string) => void,
  beforeLeave?: () => Promise<void>
) {
  if (pending) return
  update({ text: '' })
  prepareCreation(input, navigate, beforeLeave)
  await retry?.()
}

/**
 * Open a blank post in place and save nothing yet: the first word or
 * attachment makes the draft, so a post started and abandoned leaves no row.
 * Discarding returns to the page underneath. Anything seeded or aimed at a
 * target goes through `createWritingDraft`, which saves at once.
 */
export function startBlankDraft(
  input: Parameters<typeof draftsApi.create>[0],
  navigate: (id: string) => void,
  beforeLeave?: () => Promise<void>,
  /**
   * What the post is written for before it exists: the platform its text is
   * counted for, and the accounts it will publish to, shown above the text.
   */
  context: { accounts?: readonly Destination[]; channel: DraftChannel } = { channel: 'x' }
) {
  if (pending) return
  // Kept in the store's value, not beside it, so what is shown always follows it.
  update({ channel: context.channel, destinations: context.accounts, text: '', waiting: true })
  prepareCreation(input, navigate, beforeLeave)
}

function prepareCreation(
  input: Parameters<typeof draftsApi.create>[0],
  navigate: (id: string) => void,
  beforeLeave?: () => Promise<void>
) {
  // One key for every try: a retry after a lost response gets the same draft back, not a second one.
  let request = { requestKey: crypto.randomUUID(), ...input }
  // One key per piece, kept across attempts: a run that failed halfway is
  // finished by pressing again, and the pieces already created come back by
  // their key instead of being made a second time. The key belongs to the
  // piece's place and its words, so editing a piece before trying again asks
  // for a new draft rather than replaying the one with the old words.
  const pieceKeys = new Map<string, string>()
  const keyForPiece = (index: number, piece: string) => {
    const at = `${index}\u0000${piece}`
    const existing = pieceKeys.get(at)
    if (existing) return existing
    const fresh = crypto.randomUUID()
    pieceKeys.set(at, fresh)
    return fresh
  }
  // Several posts from one paste: each piece becomes its own draft, sharing a
  // series title, and the library opens its series scheduler on all of them.
  resolvePaste = async (choice, seriesName) => {
    const pieces = pending?.pieces ?? []
    if (choice === 'one') {
      update({ ...(pending ?? { text: '' }), pieces: undefined, waiting: false })
      return retry?.()
    }
    if (choice === 'thread') {
      request = { ...request, body: importedBody(pieces) }
      // The draft already holds the pasted text as posts; leaving it buffered
      // too would type the whole block into the editor again.
      update({ ...(pending ?? { text: '' }), pieces: undefined, text: '', waiting: false })
      return retry?.()
    }
    update({ ...(pending ?? { text: '' }), error: undefined, waiting: false })
    try {
      await beforeLeave?.()
      const created: string[] = []
      for (const [index, piece] of pieces.entries()) {
        const draft = await draftsApi.create({
          ...request,
          body: importedBody([piece]),
          requestKey: keyForPiece(index, piece),
          title: seriesTitle(seriesName, index, pieces.length),
        })
        created.push(draft.id)
      }
      update(null)
      resolvePaste = null
      retry = null
      navigateToSeries(created)
    } catch (error) {
      const planRequired = isPlanRefusal(error)
      update({
        ...shown(),
        pieces,
        text: pending?.text ?? '',
        error: planRequired
          ? 'Writing posts needs Pro.'
          : error instanceof Error
            ? error.message
            : 'The posts could not be created.',
        planRequired,
      })
    }
  }
  attachToWaiting = (nodes) => {
    request = {
      ...request,
      assetIds: nodes.map((node) => node.assetId),
      body: [postBreak(), { type: 'p', children: [{ text: '' }] }, ...nodes],
    }
    if (pending) update({ ...pending, waiting: false })
    void retry?.()
  }
  retry = async () => {
    if (pending) update({ ...pending, error: undefined })
    try {
      await beforeLeave?.()
      const draft = await draftsApi.create(request)
      update({ ...shown(), id: draft.id, text: pending?.text ?? '' })
      navigate(draft.id)
    } catch (error) {
      const planRequired = isPlanRefusal(error)
      update({
        ...shown(),
        text: pending?.text ?? '',
        error: planRequired
          ? 'Writing posts needs Pro.'
          : error instanceof Error
            ? error.message
            : 'Could not create the draft.',
        planRequired,
      })
    }
  }
}

/** A new post with these assets attached: it references them, as Attach from Library does. */
export function startPostWithAssets(
  assets: { id: string; mediaType: string }[],
  navigate: (id: string) => void
) {
  return createWritingDraft(
    {
      assetIds: assets.map((asset) => asset.id),
      body: [postBreak(), { type: 'p', children: [{ text: '' }] }, ...assets.map(draftAssetNode)],
    },
    navigate
  )
}

/**
 * Start a post from anywhere in the app: the quick-compose box opens over the
 * page, and the first word makes the draft, instead of opening Publish to click
 * New draft again. It lands in the workspace's default brand. Every open editor
 * saves or asks first; a cancelled leave stays put.
 */
export function useNewPost(onStart?: () => void): () => void {
  const router = useRouter()
  const pathname = usePathname()
  return () => {
    onStart?.()
    void prepareWorkspaceSwitch().then(
      () =>
        startBlankDraft({}, (id) =>
          router.push(platformHref(pathname, `/publish/${encodeURIComponent(id)}`))
        ),
      () => {}
    )
  }
}

/** Deliver buffered typing once, after the shared document has initialized. */
export function takePendingDraft(id: string): string | null {
  if (pending?.id !== id) return null
  const text = pending.text
  update(null)
  retry = null
  return text
}

/**
 * The blank post, written in place over the page's content while its draft is
 * made and its editor loads. It is not a dialog: it shows where the post goes
 * and its length as the editor does, the navigation beside it stays usable,
 * and the first word turns it into the draft's own editor without a step.
 */
export function PendingDraftInput({ variant = 'page' }: { variant?: 'editor' | 'page' }) {
  const router = useRouter()
  const pathname = usePathname()
  const value = React.useSyncExternalStore(
    subscribe,
    () => pending,
    () => null
  )
  React.useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (pending?.text) event.preventDefault()
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [])
  // A run of drafts lands in the library with its series scheduler open, so
  // one confirmation times all of them.
  React.useEffect(() => {
    navigateToSeries = (ids) =>
      router.push(
        platformHref(pathname, `/publish?series=${ids.map(encodeURIComponent).join(',')}`)
      )
    return () => {
      navigateToSeries = () => undefined
    }
  }, [pathname, router])
  const box = React.useRef<HTMLElement>(null)
  const field = React.useRef<HTMLTextAreaElement>(null)
  const open = Boolean(value)
  const [picking, setPicking] = React.useState(false)
  const [splitting, setSplitting] = React.useState(false)
  const cancel = React.useCallback(() => {
    retry = null
    attachToWaiting = null
    resolvePaste = null
    setPicking(false)
    setSplitting(false)
    update(null)
  }, [])
  // Leaving through the navigation drops a post with nothing in it; typed
  // words stay, and their draft still opens once it is made.
  const openedAt = React.useRef(pathname)
  React.useEffect(() => {
    if (!open) return
    if (openedAt.current !== pathname && pending?.waiting && !pending.text && !pending.pieces)
      cancel()
    openedAt.current = pathname
  }, [cancel, open, pathname])
  // A menu or dialog that opened the post hands focus back to its own trigger
  // as it closes, which would send the first words typed elsewhere. Focus
  // that lands outside comes back here, until the writer moves it themselves
  // (a click outside, or Tab): then the navigation beside the post keeps it.
  // Dialogs above the post always keep theirs, and the covered page never gets it.
  React.useEffect(() => {
    if (!open) return
    let moved = false
    const press = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) moved = true
    }
    const tab = (event: KeyboardEvent) => {
      if (event.key === 'Tab') moved = true
    }
    const keep = (event: FocusEvent) => {
      // Once the draft has taken the text, focus belongs to its editor.
      if (!pending) return
      const target = event.target as Element
      if (box.current?.contains(target)) return
      if (target.closest?.('[role="dialog"], [role="alertdialog"], [role="menu"]')) return
      if (moved && target.closest?.('[aria-label="Primary navigation"]')) return
      field.current?.focus()
    }
    document.addEventListener('pointerdown', press, true)
    document.addEventListener('keydown', tab, true)
    document.addEventListener('focusin', keep)
    field.current?.focus()
    return () => {
      document.removeEventListener('pointerdown', press, true)
      document.removeEventListener('keydown', tab, true)
      document.removeEventListener('focusin', keep)
    }
  }, [open])
  if (!value) return null
  const channel = value.channel ?? 'x'
  const length = platformCaptionLength(channel, value.text)
  const limit = CAPABILITIES[channel].captionLimit
  return (
    <section
      aria-label="New post"
      className={cn(
        'absolute inset-0 z-40 flex flex-col overflow-y-auto bg-background',
        variant === 'page' && 'md:inset-y-3 md:start-0 md:end-3 md:rounded-2xl md:border'
      )}
      data-testid="blank-composer"
      ref={box}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
        <span className="text-ui font-medium text-foreground">New post</span>
        {value.destinations ? (
          <DestinationSummary accounts={value.destinations} />
        ) : (
          <span className="text-label text-muted-foreground">
            Goes to your profile’s default accounts
          </span>
        )}
        <p className="ms-auto text-label text-muted-foreground" role="status">
          {value.error ?? (value.waiting ? 'Saves as you type' : 'Saving…')}
        </p>
      </header>
      <div className={cn(POST_COLUMN, 'grid gap-3 pt-6 pb-10')}>
        <Textarea
          ref={field}
          aria-label="New draft text"
          // The editor's own writing surface: no box around the words.
          className="min-h-48 resize-none border-0 bg-transparent p-0 text-body shadow-none dark:bg-transparent"
          placeholder="What would you like to share?"
          value={value.text}
          onChange={(event) => {
            if (!pending) return
            // A paste the writer has not answered for yet holds everything: the
            // choice decides what is created, so typing must not create one
            // draft. Editing it re-reads the pieces, so what the panel lists is
            // always what would be created; an edit that leaves one piece ends
            // the choice and the box goes back to making a single post.
            if (pending.pieces) {
              const pieces = pastePieces(event.target.value)
              return update({
                ...pending,
                pieces: pieces.length > 1 ? pieces : undefined,
                text: event.target.value,
              })
            }
            const makeIt = pending.waiting && event.target.value.trim()
            update({ ...pending, text: event.target.value, waiting: makeIt ? false : pending.waiting })
            if (makeIt) void retry?.()
          }}
          // Only a paste offers the split. Typing a blank line is writing one
          // post with a paragraph in it, and must not interrupt.
          onPaste={(event) => {
            if (!pending?.waiting) return
            const pasted = event.clipboardData.getData('text/plain')
            const box = event.currentTarget
            const next =
              box.value.slice(0, box.selectionStart ?? 0) +
              pasted +
              box.value.slice(box.selectionEnd ?? 0)
            const pieces = pastePieces(next)
            if (pieces.length < 2) return
            event.preventDefault()
            update({ ...pending, pieces, text: next })
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && value.waiting && !value.text) cancel()
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'text-label tabular-nums',
              length > limit ? 'text-destructive' : 'text-muted-foreground'
            )}
            data-testid="blank-composer-count"
          >
            {length}/{limit}
          </span>
          {value.waiting && !value.pieces ? (
            <>
              <Button className="ms-auto" onClick={() => setPicking(true)} variant="outline">
                Add media
              </Button>
              <Button onClick={cancel} title="Discard (Esc)" variant="ghost">
                Discard
              </Button>
            </>
          ) : null}
        </div>
        {value.pieces ? (
          <PasteSplit
            busy={splitting}
            channel={channel}
            onChoose={(choice, seriesName) => {
              setSplitting(true)
              void resolvePaste?.(choice, seriesName).finally(() => setSplitting(false))
            }}
            pieces={value.pieces}
          />
        ) : null}
        {value.pieces ? (
          <Button className="w-fit" onClick={cancel} variant="ghost">
            Discard
          </Button>
        ) : null}
        {picking ? (
          <LibraryAssetPicker
            onClose={() => setPicking(false)}
            onInsert={(nodes) => attachToWaiting?.(nodes)}
          />
        ) : null}
        {/* A pending paste answers for itself: its three buttons are the retry,
            and the one below would instead make a single draft of the block. */}
        {value.error && !value.pieces ? (
          <div className="flex gap-2">
            {value.planRequired ? (
              <ButtonLink
                href={`/upgrade?from=${encodeURIComponent('/publish')}`}
                onClick={() => {
                  retry = null
                  update(null)
                }}
              >
                See plans
              </ButtonLink>
            ) : (
              <Button onClick={() => void retry?.()}>Retry</Button>
            )}
            {value.id ? null : (
              // Nothing was created: a refusal (such as no permission to write) must not trap the page.
              <Button onClick={cancel} variant="outline">
                Cancel
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </section>
  )
}

/** Keep early text available if the collaboration connection needs another attempt. */
export function pendingDraftConnectionError(id: string, reconnect: () => void) {
  if (pending?.id !== id) return
  update({ ...pending, error: 'Could not connect yet. Your text is kept here.' })
  retry = async () => {
    if (pending) update({ ...pending, error: undefined })
    reconnect()
  }
}
