'use client'

import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { listContentDraftsContract } from '@/lib/api/contracts/content-drafts'
import { serializeDraft } from '@/lib/content-drafts/serialize'
import { readWire } from '@/lib/plan/wire'
import type { DraftChannel } from '@/lib/write/document'

/** One caption to reuse: a draft's text, and where it came from. */
export type PastCaption = { draftId: string; text: string; title: string }

/**
 * The captions a search found, in the list's order (pinned drafts first): the
 * workspace's other drafts with text, each written as the channel being
 * edited posts it, each text once.
 */
export function captionChoices(
  drafts: readonly { body: unknown; id: string; title: string }[],
  currentDraftId: string,
  channel: DraftChannel
): PastCaption[] {
  const seen = new Set<string>()
  return drafts.flatMap((draft) => {
    if (draft.id === currentDraftId) return []
    const text = serializeDraft(draft.body, channel).caption.trim()
    if (!text || seen.has(text)) return []
    seen.add(text)
    return [{ draftId: draft.id, text, title: draft.title }]
  })
}

/** Search the workspace's drafts and put one's text where the cursor is. */
export function PastCaptions({
  channel,
  draftId,
  onApply,
  onClose,
  setId,
}: {
  /** The version being edited; a caption is written as this channel posts it. */
  channel: DraftChannel
  draftId: string
  onApply: (text: string) => void
  onClose: () => void
  setId: string | null
}) {
  const [search, setSearch] = React.useState('')
  const [state, setState] = React.useState<
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; captions: PastCaption[] }
  >({ status: 'loading' })
  const [attempt, setAttempt] = React.useState(0)
  React.useEffect(() => {
    const abort = new AbortController()
    const timer = setTimeout(() => {
      setState({ status: 'loading' })
      const query = new URLSearchParams({ limit: '25' })
      if (search.trim()) query.set('search', search.trim())
      if (setId) query.set('socialSetId', setId)
      fetch(`/api/v1/content-drafts?${query}`, { signal: abort.signal })
        .then(async (response) => {
          if (!response.ok)
            throw new Error(`The drafts could not be searched (${response.status}).`)
          // The list's timestamps are ISO strings on the wire, read back through their codecs.
          const page = readWire(listContentDraftsContract.output, await response.json())
          setState({
            status: 'ready',
            captions: captionChoices([...page.pinned, ...page.items], draftId, channel),
          })
        })
        .catch((error: unknown) => {
          if (abort.signal.aborted) return
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : 'The drafts could not be searched.',
          })
        })
    }, 250)
    return () => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [attempt, channel, draftId, search, setId])
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open>
      <DialogContent className="max-w-lg" data-testid="past-captions">
        <DialogHeader>
          <DialogTitle>Past captions</DialogTitle>
          <DialogDescription>
            Search the text of this workspace’s drafts, and put one where your cursor is.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Search past captions"
          autoFocus
          maxLength={200}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search drafts"
          value={search}
        />
        <div aria-live="polite" className="grid max-h-80 gap-1 overflow-y-auto">
          {state.status === 'loading' ? (
            <p className="text-ui text-muted-foreground">Searching…</p>
          ) : state.status === 'error' ? (
            <div className="grid gap-2" role="alert">
              <p className="text-ui text-destructive">{state.message}</p>
              <Button onClick={() => setAttempt((count) => count + 1)} size="sm" variant="outline">
                Try again
              </Button>
            </div>
          ) : state.captions.length === 0 ? (
            <p className="text-ui text-muted-foreground">
              {search.trim() ? 'No draft’s text matches.' : 'No other draft has text yet.'}
            </p>
          ) : (
            state.captions.map((caption) => (
              <Button
                className="grid h-auto justify-items-start gap-0.5 rounded-md px-3 py-2 text-left whitespace-normal hover:bg-foreground/[0.04]"
                key={caption.draftId}
                onClick={() => {
                  onApply(caption.text)
                  onClose()
                }}
                size={null}
                variant="custom"
              >
                <span className="line-clamp-3 text-ui text-foreground">{caption.text}</span>
                {caption.title && caption.title !== caption.text ? (
                  <span className="text-label text-muted-foreground">{caption.title}</span>
                ) : null}
              </Button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
