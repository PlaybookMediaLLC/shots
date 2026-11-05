'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Pill } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { type DraftWire, draftsApi, type RevisionWire } from '@/lib/content-drafts/client'
import { LocalTime, useHydrated } from './local-time'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

/** The parts of a draft its review and share state live in. */
export type DraftReview = Pick<
  DraftWire,
  'approvedVersion' | 'reviewNote' | 'reviewStatus' | 'shareToken' | 'version'
>

/**
 * Review before scheduling: a writer asks, an approver approves or asks for
 * changes. Approval is for the version it was given at, so an edit after it
 * shows as changed and needs another look.
 */
export function ReviewControls({
  canEdit,
  canReview,
  draftId,
  onDraft,
  review,
}: {
  canEdit: boolean
  /** Approval is separate from writing and publishing. */
  canReview: boolean
  draftId: string
  onDraft: (draft: DraftWire) => void
  review: DraftReview
}) {
  const [note, setNote] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const act = async (action: 'request' | 'approve' | 'changes') => {
    setBusy(true)
    try {
      onDraft(await draftsApi.review(draftId, { action, note: note.trim() || undefined }))
      setNote('')
      toast.success(
        { approve: 'Approved.', changes: 'Changes requested.', request: 'Review requested.' }[
          action
        ]
      )
    } catch (error) {
      toast.error(message(error))
    } finally {
      setBusy(false)
    }
  }
  const approved = review.reviewStatus === 'approved' && review.approvedVersion === review.version
  const label = approved
    ? 'Approved'
    : review.reviewStatus === 'approved'
      ? 'Changed since approval'
      : review.reviewStatus === 'pending'
        ? 'In review'
        : review.reviewStatus === 'changes_requested'
          ? 'Changes requested'
          : 'Request review'
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="custom"
          size={null}
          aria-label="Review"
          className="flex items-center"
          type="button"
        >
          <Pill tone={approved ? 'green' : review.reviewStatus === 'pending' ? 'blue' : 'gray'}>
            {label}
          </Pill>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-72 flex-col gap-2 p-3 text-sm">
        <p className="font-medium text-foreground">Review</p>
        {review.reviewNote ? (
          <p className="rounded-md bg-foreground/[0.04] p-2 text-xs text-foreground/80">
            {review.reviewNote}
          </p>
        ) : null}
        <Textarea
          aria-label="Review note"
          className="min-h-16 rounded-md border border-foreground/[0.08] bg-transparent p-2 text-xs outline-none focus:border-sky-400/50"
          onChange={(event) => setNote(event.target.value)}
          placeholder="A note, if you want one"
          value={note}
        />
        <div className="flex flex-wrap gap-2">
          {canEdit && !approved && review.reviewStatus !== 'pending' ? (
            <Button disabled={busy} onClick={() => void act('request')} size="sm">
              Ask for review
            </Button>
          ) : null}
          {canReview && !approved ? (
            <Button disabled={busy} onClick={() => void act('approve')} size="sm">
              Approve
            </Button>
          ) : null}
          {canReview ? (
            <Button disabled={busy} onClick={() => void act('changes')} size="sm" variant="outline">
              Request changes
            </Button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** A read-and-comment link for people outside the workspace. */
export function ShareMenu({
  canEdit,
  draftId,
  onDraft,
  shareToken,
}: {
  canEdit: boolean
  draftId: string
  onDraft: (draft: DraftWire) => void
  shareToken: string | null
}) {
  const [busy, setBusy] = React.useState(false)
  // The server render has no window: the link appears once in the browser.
  const hydrated = useHydrated()
  const link = shareToken && hydrated ? `${window.location.origin}/d/${shareToken}` : null
  const toggle = async (enabled: boolean) => {
    setBusy(true)
    try {
      onDraft(await draftsApi.share(draftId, enabled))
    } catch (error) {
      toast.error(message(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost">
          Share
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-3 p-3 text-sm">
        <Label className="flex items-center justify-between gap-3 text-foreground">
          Anyone with the link can read and comment
          <Switch
            aria-label="Share link"
            checked={Boolean(shareToken)}
            className="shrink-0"
            disabled={!canEdit || busy}
            onCheckedChange={(checked) => void toggle(checked === true)}
          />
        </Label>
        {link ? (
          <div className="flex gap-2">
            <Input
              aria-label="Link to share"
              className="min-w-0 flex-1 rounded-md border border-foreground/[0.08] bg-transparent px-2 py-1 text-xs text-foreground/80"
              readOnly
              value={link}
            />
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(link)
                toast.success('Link copied.')
              }}
              size="sm"
              variant="outline"
            >
              Copy
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Off: nobody outside the workspace can open it.
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** The draft's saved revisions; restoring one replaces the text in the editor. */
export function HistorySheet({
  draftId,
  onRestore,
}: {
  draftId: string
  onRestore: (revision: RevisionWire) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [items, setItems] = React.useState<RevisionWire[] | null>(null)
  React.useEffect(() => {
    if (!open) return
    draftsApi
      .revisions(draftId)
      .then(({ items: revisions }) => setItems(revisions))
      .catch((error: unknown) => toast.error(message(error)))
  }, [draftId, open])
  const restore = async (id: string) => {
    try {
      onRestore(await draftsApi.revision(draftId, id))
      setOpen(false)
      toast.success('Restored. Undo brings the newer text back.')
    } catch (error) {
      toast.error(message(error))
    }
  }
  return (
    <Sheet onOpenChange={setOpen} open={open}>
      <Button onClick={() => setOpen(true)} size="sm" variant="ghost">
        History
      </Button>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md" side="right">
        <SheetHeader>
          <SheetTitle>History</SheetTitle>
          <SheetDescription>
            Saved every ten minutes of editing and on every schedule.
          </SheetDescription>
        </SheetHeader>
        <ul className="flex flex-col gap-2 p-4">
          {items === null ? <li className="text-sm text-muted-foreground">Loading…</li> : null}
          {items?.length === 0 ? (
            <li className="text-sm text-muted-foreground">
              No revisions yet: they start with edits.
            </li>
          ) : null}
          {items?.map((item) => (
            <li
              className="rounded-lg border border-foreground/[0.06] p-3"
              data-testid="revision"
              key={item.id}
            >
              <p className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  <LocalTime value={item.createdAt} /> · version {item.version}
                </span>
                <Button
                  variant="custom"
                  size={null}
                  className="text-sky-700 dark:text-sky-300 hover:text-sky-700 dark:hover:text-sky-200"
                  onClick={() => void restore(item.id)}
                  type="button"
                >
                  Restore
                </Button>
              </p>
              <p className="mt-1 line-clamp-3 text-sm text-foreground">
                {item.plainText || 'Empty draft'}
              </p>
            </li>
          ))}
        </ul>
      </SheetContent>
    </Sheet>
  )
}

/** Comments guests left through the share link. */
export function GuestComments({ comments }: { comments: DraftWire['guestComments'] }) {
  if (comments.length === 0) return null
  return (
    <section className="mb-10">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Comments from the share link
      </h2>
      <ul className="flex flex-col gap-2" data-testid="guest-comments">
        {comments.map((comment) => (
          <li
            className="rounded-lg border border-foreground/[0.06] px-3 py-2"
            key={`${comment.createdAt}-${comment.name}`}
          >
            <p className="text-xs text-muted-foreground">
              <span className="text-foreground">{comment.name}</span> ·{' '}
              <LocalTime value={comment.createdAt} />
            </p>
            <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">{comment.text}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}
