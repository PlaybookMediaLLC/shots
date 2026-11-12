'use client'

import * as React from 'react'
import { ArrowBackIcon, ArrowForwardIcon, OutwardIcon } from '@/components/platform-shell/icons'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import type { BatchItem } from '@/lib/api/contracts/content-batches'
import {
  type BatchAccount,
  previewPublications,
  stagedChecks,
  waitingToRender,
} from '@/lib/write/batch'
import type { VersionOptions } from '@/lib/write/document'
import { PreviewPanel, type PreviewSelection } from '../composer/preview'

/** Keys pressed in the device menu or on a video stay there; elsewhere the arrows step through posts. */
const ownsArrows = (target: EventTarget) =>
  target instanceof HTMLElement &&
  Boolean(target.closest('video, audio, [role="combobox"], [role="listbox"]'))

/**
 * A batch's posts as their platforms show them, one at a time, in a side
 * sheet. The arrows and the ← and → keys step through the posts, and the
 * platform and device chosen stay as they step. The post is followed by its
 * id, so a list that changes underneath never shows another post.
 */
export function BatchPreviewSheet({
  accounts,
  itemId,
  items,
  onItemChange,
  options,
}: {
  accounts: readonly BatchAccount[]
  /** The post shown; null keeps the sheet closed. */
  itemId: string | null
  items: readonly BatchItem[]
  onItemChange: (itemId: string | null) => void
  options: VersionOptions
}) {
  const [selection, setSelection] = React.useState<PreviewSelection>({
    channel: null,
    device: 'desktop',
  })
  // The sheet opens from page state, not a trigger, so it returns focus itself.
  const opener = React.useRef<HTMLElement | null>(null)
  const index = items.findIndex((candidate) => candidate.id === itemId)
  const item = index < 0 ? undefined : items[index]
  const preview = React.useMemo(
    () => (item ? previewPublications(item, accounts, options) : { cards: [] }),
    [item, accounts, options]
  )
  const step = (by: number) => {
    const next = items[index + by]
    if (index >= 0 && next) onItemChange(next.id)
  }
  const uploading = item?.media.filter((entry) => !entry.assetId).length ?? 0
  // The media rules need every file uploaded; a saved draft is checked in Write.
  const problems = [
    ...(preview.problem ? [preview.problem] : []),
    ...(item && !uploading && !item.draftId && !waitingToRender(item)
      ? [...stagedChecks(item, accounts).entries()].flatMap(([id, check]) =>
          check.problems.map(
            (problem) => `${accounts.find((account) => account.id === id)?.name}: ${problem}`
          )
        )
      : []),
  ]
  const caption = (item?.draft?.plainText ?? item?.caption ?? '').trim().split('\n')[0]
  const first = index <= 0
  const last = index >= items.length - 1
  return (
    <Sheet open={Boolean(item)} onOpenChange={(open) => (open ? null : onItemChange(null))}>
      <SheetContent
        className="w-full gap-0 p-0 sm:max-w-[40rem]"
        data-testid="batch-preview"
        side="right"
        onCloseAutoFocus={(event) => {
          if (!opener.current?.isConnected) return
          event.preventDefault()
          opener.current.focus()
        }}
        onKeyDown={(event) => {
          if (ownsArrows(event.target)) return
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            step(event.key === 'ArrowLeft' ? -1 : 1)
          }
        }}
        onOpenAutoFocus={() => {
          opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
      >
        <SheetHeader className="border-b border-border pe-14">
          <div className="flex items-center gap-2">
            {/* aria-disabled, not disabled: the focused arrow keeps focus at either end. */}
            <Button
              aria-disabled={first}
              aria-label="Previous post"
              className="aria-disabled:cursor-default aria-disabled:opacity-50"
              onClick={() => step(-1)}
              size="icon-sm"
              variant="outline"
            >
              <ArrowBackIcon />
            </Button>
            <Button
              aria-disabled={last}
              aria-label="Next post"
              className="aria-disabled:cursor-default aria-disabled:opacity-50"
              onClick={() => step(1)}
              size="icon-sm"
              variant="outline"
            >
              <ArrowForwardIcon />
            </Button>
            <SheetTitle aria-live="polite" className="ms-1 text-ui font-medium tabular-nums">
              Post {index + 1} of {items.length}
            </SheetTitle>
          </div>
          <SheetDescription className="truncate">{caption || 'No caption'}</SheetDescription>
        </SheetHeader>
        {item ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {waitingToRender(item) ? (
              <p className="mx-4 mt-4 text-label text-muted-foreground">
                This grid video is not rendered yet. Render it to see it here.
              </p>
            ) : uploading ? (
              <p className="mx-4 mt-4 text-label text-muted-foreground" role="status">
                {uploading} file{uploading === 1 ? ' is' : 's are'} still uploading. They show here
                once uploaded.
              </p>
            ) : null}
            {item.draftId ? (
              <p className="mx-4 mt-4 text-label text-muted-foreground">
                Saved as a draft.{' '}
                <a
                  className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
                  href={`/publish/${item.draftId}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  Open it in Write
                  <OutwardIcon aria-hidden className="size-3" />
                </a>{' '}
                for its exact preview, with edits made there.
              </p>
            ) : null}
            {problems.length ? (
              <ul className="mx-4 mt-4 grid gap-0.5" role="alert">
                {problems.map((problem) => (
                  <li className="text-label text-destructive" key={problem}>
                    {problem}
                  </li>
                ))}
              </ul>
            ) : null}
            {preview.cards.length ? (
              <PreviewPanel
                items={preview.cards}
                onSelect={setSelection}
                selection={selection}
                target={null}
              />
            ) : preview.problem ? null : (
              <p className="m-4 text-label text-muted-foreground">
                This post goes to no account yet. Choose its accounts from its time and accounts
                panel.
              </p>
            )}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
