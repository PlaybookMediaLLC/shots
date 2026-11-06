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
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

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
}
let pending: PendingDraft | null = null
/** Attach media to a post still waiting to be made, and make it. */
let attachToWaiting: ((nodes: ReturnType<typeof draftAssetNode>[]) => void) | null = null
/** Act on a paste the writer has separated into pieces. */
let resolvePaste: ((choice: PasteChoice, seriesName: string) => Promise<void>) | null = null
/** The platform the new-draft box counts pasted pieces against. */
let countingChannel: DraftChannel = 'x'
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
 * Open the box for a blank post and save nothing yet: the first word or
 * attachment makes the draft, so a post started and abandoned leaves no row.
 * Cancelling returns to the page underneath. Anything seeded or aimed at a
 * target goes through `createWritingDraft`, which saves at once.
 */
export function startBlankDraft(
  input: Parameters<typeof draftsApi.create>[0],
  navigate: (id: string) => void,
  beforeLeave?: () => Promise<void>,
  /** The platform a pasted run is measured against; X unless the brand says otherwise. */
  channel: DraftChannel = 'x'
) {
  if (pending) return
  countingChannel = channel
  update({ text: '', waiting: true })
  prepareCreation(input, navigate, beforeLeave)
}

function prepareCreation(
  input: Parameters<typeof draftsApi.create>[0],
  navigate: (id: string) => void,
  beforeLeave?: () => Promise<void>
) {
  // One key for every try: a retry after a lost response gets the same draft back, not a second one.
  let request = { requestKey: crypto.randomUUID(), ...input }
  // Several posts from one paste: each piece becomes its own draft, sharing a
  // series title, and the library opens its series scheduler on all of them.
  // A lost response is replayed by the piece's own key, so a retry never
  // doubles the run.
  resolvePaste = async (choice, seriesName) => {
    const pieces = pending?.pieces ?? []
    if (choice === 'one') {
      update({ ...(pending ?? { text: '' }), pieces: undefined, waiting: false })
      return retry?.()
    }
    if (choice === 'thread') {
      request = { ...request, body: importedBody(pieces) }
      update({ ...(pending ?? { text: '' }), pieces: undefined, waiting: false })
      return retry?.()
    }
    update({ ...(pending ?? { text: '' }), error: undefined, waiting: false })
    const keys = pieces.map(() => crypto.randomUUID())
    try {
      await beforeLeave?.()
      const created: string[] = []
      for (const [index, piece] of pieces.entries()) {
        const draft = await draftsApi.create({
          ...request,
          body: importedBody([piece]),
          requestKey: keys[index],
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
      update({ id: draft.id, text: pending?.text ?? '' })
      navigate(draft.id)
    } catch (error) {
      const planRequired = isPlanRefusal(error)
      update({
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

/** A typing surface that remains mounted while the route and editor load. */
export function PendingDraftInput() {
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
  const box = React.useRef<HTMLDivElement>(null)
  const field = React.useRef<HTMLTextAreaElement>(null)
  const open = Boolean(value)
  const [picking, setPicking] = React.useState(false)
  const [splitting, setSplitting] = React.useState(false)
  const cancel = () => {
    retry = null
    attachToWaiting = null
    resolvePaste = null
    setPicking(false)
    setSplitting(false)
    update(null)
  }
  // The box covers the page, so focus stays in it. A menu or dialog that opened
  // it hands focus back to its own trigger as it closes, which would otherwise
  // send the first words typed to a hidden control.
  React.useEffect(() => {
    if (!open) return
    const keep = (event: FocusEvent) => {
      // Once the draft has taken the text, focus belongs to its editor.
      if (!pending) return
      const target = event.target as Element
      if (box.current?.contains(target)) return
      // A dialog opened above this box keeps its own focus.
      if (target.closest?.('[role="dialog"], [role="alertdialog"]')) return
      field.current?.focus()
    }
    document.addEventListener('focusin', keep)
    field.current?.focus()
    return () => document.removeEventListener('focusin', keep)
  }, [open])
  if (!value) return null
  return (
    <div
      aria-label="New draft"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-6"
      ref={box}
      role="dialog"
    >
      <div className="w-full max-w-xl space-y-3">
        <p role="status">{value.error ?? (value.waiting ? 'New post' : 'Saving your post…')}</p>
        <Textarea
          ref={field}
          aria-label="New draft text"
          className="min-h-48"
          placeholder="What would you like to share?"
          value={value.text}
          onChange={(event) => {
            if (!pending) return
            // A paste the writer has not answered for yet holds everything: the
            // choice decides what is created, so typing must not create one draft.
            if (pending.pieces) return update({ ...pending, text: event.target.value })
            const makeIt = pending.waiting && event.target.value.trim()
            update({ ...pending, text: event.target.value, waiting: makeIt ? false : pending.waiting })
            if (makeIt) void retry?.()
          }}
          // Only a paste offers the split. Typing a blank line is writing one
          // post with a paragraph in it, and must not interrupt.
          onPaste={(event) => {
            if (!pending?.waiting) return
            const pasted = event.clipboardData.getData('text/plain')
            const field = event.currentTarget
            const next =
              field.value.slice(0, field.selectionStart ?? 0) +
              pasted +
              field.value.slice(field.selectionEnd ?? 0)
            const pieces = pastePieces(next)
            if (pieces.length < 2) return
            event.preventDefault()
            update({ ...pending, pieces, text: next })
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && value.waiting && !value.text) cancel()
          }}
        />
        {value.pieces ? (
          <PasteSplit
            busy={splitting}
            channel={countingChannel}
            onChoose={(choice, seriesName) => {
              setSplitting(true)
              void resolvePaste?.(choice, seriesName).finally(() => setSplitting(false))
            }}
            pieces={value.pieces}
          />
        ) : null}
        {value.waiting && !value.pieces ? (
          <div className="flex gap-2">
            <Button onClick={() => setPicking(true)} variant="outline">
              Add media
            </Button>
            <Button onClick={cancel} variant="ghost">
              Cancel
            </Button>
          </div>
        ) : null}
        {value.pieces ? (
          <Button className="w-fit" onClick={cancel} variant="ghost">
            Cancel
          </Button>
        ) : null}
        {picking ? (
          <LibraryAssetPicker
            onClose={() => setPicking(false)}
            onInsert={(nodes) => attachToWaiting?.(nodes)}
          />
        ) : null}
        {value.error ? (
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
