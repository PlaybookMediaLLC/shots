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
import { CHANNEL_META, ChannelIcon } from '@/components/drafts/channel-meta'
import { ImageIcon } from '@/components/platform-shell/icons'
import { platformCaptionLength } from '@/lib/content-drafts/serialize'
import { CAPABILITIES } from '@/lib/write/capabilities'
import { cn } from '@/lib/utils'
import { PLACEHOLDERS, POST_TEXT, PostAuthor, PostCount } from './composer/post-identity'
import type { Destination } from './destination-summary'

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
  /** The page it was opened on: leaving it with nothing written drops the post. */
  openedAt?: string
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
const shown = () => ({
  channel: pending?.channel,
  destinations: pending?.destinations,
  openedAt: pending?.openedAt,
})
/** Where the caret was, so a post that moves into the editor's column keeps it. */
let caret = 0
/** Gives the page under the post back its focus, before the draft's editor takes it. */
let releaseCover: (() => void) | null = null
/** Write pages mounted now: the post opens in their editor column rather than over the page. */
let hosts = 0
const hostListeners = new Set<() => void>()
const subscribeHosts = (listener: () => void) => {
  hostListeners.add(listener)
  return () => {
    hostListeners.delete(listener)
  }
}
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
  caret = 0
  update({
    channel: context.channel,
    destinations: context.accounts,
    openedAt: window.location.pathname,
    text: '',
    waiting: true,
  })
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

/** Whether a new post is open, for the page that lays out around it. */
export function useBlankDraft(): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => pending !== null,
    () => false
  )
}

/** Deliver buffered typing once, after the shared document has initialized. */
export function takePendingDraft(id: string): string | null {
  if (pending?.id !== id) return null
  // The editor focuses as soon as it has the words; the page under the post must take focus by then.
  releaseCover?.()
  const text = pending.text
  update(null)
  retry = null
  return text
}

/**
 * The blank post, drawn as the composer draws a draft: the header, the
 * platforms it goes to with the main one marked, the account's avatar and
 * handle, the editor's text and the length ring. On a Write page it takes the
 * editor's column beside the drafts list; elsewhere it covers the page's
 * content. The first word makes the draft and its editor takes over in place.
 */
export function PendingDraftInput({ variant = 'page' }: { variant?: 'editor' | 'page' | 'write' }) {
  const router = useRouter()
  const pathname = usePathname()
  const value = React.useSyncExternalStore(
    subscribe,
    () => pending,
    () => null
  )
  const hosted = React.useSyncExternalStore(
    subscribeHosts,
    () => hosts > 0,
    () => false
  )
  // A Write page draws the post in its editor column; the shell's copy then stays out of the way.
  React.useLayoutEffect(() => {
    if (variant !== 'write') return
    hosts += 1
    hostListeners.forEach((listener) => listener())
    return () => {
      hosts -= 1
      hostListeners.forEach((listener) => listener())
    }
  }, [variant])
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
  const shown = Boolean(value) && (variant === 'write' || !hosted)
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
  // Leaving the page it was opened on drops a post with nothing in it; typed
  // words stay, and their draft still opens once it is made.
  React.useEffect(() => {
    if (pending?.waiting && !pending.text && !pending.pieces && pending.openedAt !== pathname)
      cancel()
  }, [cancel, pathname])
  // The page under the post is inert while it is open, so neither the keyboard
  // nor a menu closing elsewhere can put focus there. Focus a menu or dialog
  // hands back to its trigger comes to the post until the writer moves it
  // themselves (a click outside, or Tab); then the controls beside it keep it.
  React.useEffect(() => {
    if (!shown) return
    const covered = box.current?.previousElementSibling
    const wasInert = covered instanceof HTMLElement ? covered.inert : false
    const release = () => {
      if (covered instanceof HTMLElement) covered.inert = wasInert
    }
    if (covered instanceof HTMLElement) covered.inert = true
    releaseCover = release
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
      if (moved) return
      field.current?.focus()
    }
    document.addEventListener('pointerdown', press, true)
    document.addEventListener('keydown', tab, true)
    document.addEventListener('focusin', keep)
    field.current?.focus()
    field.current?.setSelectionRange(caret, caret)
    return () => {
      release()
      if (releaseCover === release) releaseCover = null
      document.removeEventListener('pointerdown', press, true)
      document.removeEventListener('keydown', tab, true)
      document.removeEventListener('focusin', keep)
    }
  }, [shown])
  if (!value || !shown) return null
  const channel = value.channel ?? 'x'
  const length = platformCaptionLength(channel, value.text)
  const limit = CAPABILITIES[channel].captionLimit
  const author = value.destinations?.find((account) => account.channel === channel)
  return (
    <section
      aria-label="New post"
      className={cn(
        'absolute inset-0 z-30 flex flex-col overflow-y-auto bg-card',
        variant === 'page' && 'md:inset-y-3 md:start-0 md:end-3 md:rounded-2xl md:border'
      )}
      data-testid="blank-composer"
      // Write's shortcuts listen on the window and act on the draft under this one.
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey || event.altKey) && event.key !== 'k')
          event.stopPropagation()
      }}
      ref={box}
    >
      {/* The composer's header: the title row, then its actions. */}
      <header className="sticky top-0 z-20 flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card/90 px-3 py-2 backdrop-blur">
        <span className="h-8 min-w-20 max-w-64 flex-1 truncate px-3 text-ui-lg leading-8 font-medium text-muted-foreground">
          New post
        </span>
        <span
          className={cn(
            'min-w-[8ch] shrink-0 text-xs',
            value.error ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'
          )}
          role="status"
        >
          {value.error ?? (value.waiting ? 'Not saved yet' : 'Saving…')}
        </span>
        <div className="ml-auto flex min-h-8 basis-full items-center justify-end gap-1">
          {value.waiting ? (
            <Button onClick={cancel} size="sm" title="Discard (Esc)" variant="ghost">
              Discard
            </Button>
          ) : null}
        </div>
      </header>
      {/* The platforms it goes to, as the composer's tabs show them. */}
      <div
        aria-label="Platforms"
        className="flex flex-wrap items-center gap-2 px-4 py-3"
        data-testid="destination-summary"
        role="group"
      >
        {value.destinations?.length ? (
          value.destinations.map((account) => (
            <span
              className={cn(
                'flex h-8 items-center gap-2 rounded-md border px-3 text-ui',
                account.channel === channel
                  ? 'border-input bg-foreground/[0.08] text-foreground'
                  : 'border-border text-muted-foreground'
              )}
              key={account.id}
            >
              <ChannelIcon channel={account.channel} />
              {CHANNEL_META[account.channel].label}
              <span className="text-label text-muted-foreground">
                {account.handle ? `@${account.handle.replace(/^@/, '')}` : null}
                {account.channel === channel ? ' · Main' : null}
              </span>
            </span>
          ))
        ) : (
          <span className="text-label text-muted-foreground">
            Goes to your profile’s default accounts
          </span>
        )}
      </div>
      {author ? (
        <p className="px-4 text-label text-muted-foreground">
          {author.displayName ?? CHANNEL_META[channel].label}
          {author.handle ? ` · @${author.handle.replace(/^@/, '')}` : ''} · saved as a draft when
          you start writing
        </p>
      ) : null}
      {/* Where the composer keeps its account controls; the post starts below, as it does there. */}
      <div className="relative pt-20 pb-10">
        <div className={POST_COLUMN}>
          <PostAuthor
            avatarUrl={author?.avatarUrl}
            channel={channel}
            handle={author?.handle}
            name={author?.displayName ?? author?.handle ?? 'New post'}
          />
        </div>
        <Textarea
          ref={field}
          aria-label="New draft text"
          // The editor's own writing surface: its type, its measure, no box.
          className={cn(POST_COLUMN, POST_TEXT, 'min-h-7 pt-1')}
          data-slot="post-text"
          placeholder={PLACEHOLDERS[channel] ?? `Write your ${CHANNEL_META[channel].label} post…`}
          value={value.text}
          onSelect={(event) => {
            caret = event.currentTarget.selectionStart ?? 0
          }}
          onChange={(event) => {
            caret = event.target.selectionStart ?? event.target.value.length
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
        <div className={cn(POST_COLUMN, 'flex h-8 items-center')}>
          <PostCount
            active
            channel={channel}
            length={length}
            limit={limit}
            number={1}
            thread={false}
          />
        </div>
        <div className={cn(POST_COLUMN, 'mt-6 grid gap-3')}>
          {/* The editor's toolbar, with what a post can take before it exists. */}
          {value.waiting && !value.pieces ? (
            <div className="flex w-fit items-center gap-0.5 rounded-lg border border-border bg-card/95 p-1 shadow-popover">
              <Button
                aria-label="Add media"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setPicking(true)}
                size="icon-sm"
                title="Image or video"
                variant="ghost"
              >
                <ImageIcon aria-hidden />
              </Button>
            </div>
          ) : null}
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
