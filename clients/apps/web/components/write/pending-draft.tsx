'use client'

import * as React from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { draftsApi } from '@/lib/content-drafts/client'
import { draftAssetNode } from '@/lib/platform/asset-handoff'
import { postBreak } from '@/lib/write/versions'
import { prepareWorkspaceSwitch } from '@/lib/platform/navigation-guard'
import { platformHref } from '@/lib/platform/navigation'
import { isPlanRefusal } from '@/lib/api/platform-errors'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

type PendingDraft = { id?: string; text: string; error?: string; planRequired?: boolean }
let pending: PendingDraft | null = null
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
  // One key for every try: a retry after a lost response gets the same draft back, not a second one.
  const request = { requestKey: crypto.randomUUID(), ...input }
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
  await retry()
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
 * Start a post from anywhere in the app: the draft is made at once, with the
 * quick-compose box up meanwhile, instead of opening Publish to click New
 * draft again. It lands in the workspace's default brand. Every open editor
 * saves or asks first; a cancelled leave stays put.
 */
export function useNewPost(onStart?: () => void): () => void {
  const router = useRouter()
  const pathname = usePathname()
  return () => {
    onStart?.()
    void prepareWorkspaceSwitch().then(
      () =>
        createWritingDraft({}, (id) =>
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
  const box = React.useRef<HTMLDivElement>(null)
  const field = React.useRef<HTMLTextAreaElement>(null)
  const open = Boolean(value)
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
        <p role="status">{value.error ?? 'New draft · Connecting in the background'}</p>
        <Textarea
          ref={field}
          aria-label="New draft text"
          className="min-h-48"
          placeholder="What would you like to share?"
          value={value.text}
          onChange={(event) => {
            if (pending) update({ ...pending, text: event.target.value })
          }}
        />
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
              <Button
                onClick={() => {
                  retry = null
                  update(null)
                }}
                variant="outline"
              >
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
