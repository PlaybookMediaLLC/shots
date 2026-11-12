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
  itemAccounts,
  stagedBody,
  stagedChecks,
  stagedVersions,
  waitingToRender,
} from '@/lib/write/batch'
import type { VersionOptions } from '@/lib/write/document'
import { buildPublication } from '@/lib/write/publication'
import { readVersions } from '@/lib/write/versions'
import { type PreviewCard, PreviewPanel, type PreviewSelection } from '../composer/preview'

/**
 * What each of a post's accounts would show, built as saving its draft
 * builds it: the same body, platform versions and publication. A saved
 * draft may have changed in Write since; its own preview there is exact.
 */
export function batchPreviewCards(
  item: BatchItem,
  accounts: readonly BatchAccount[],
  options: VersionOptions
): PreviewCard[] {
  const ids = itemAccounts(item)
  const chosen = accounts.filter((account) => ids.includes(account.id))
  const draft = {
    article: null,
    body: stagedBody({ caption: item.draft?.plainText ?? item.caption, media: item.media }),
    kind: 'standard' as const,
    platformVersions:
      stagedVersions(
        item,
        chosen.map((account) => account.channel),
        options
      ) ?? readVersions(undefined),
    target: null,
  }
  return chosen.map((account) => ({
    account,
    publication: buildPublication(draft, {
      channel: account.channel,
      connectionId: account.id,
      standing: {
        maxWeightedCharacters: account.xCaptionLimit,
        tiktokCreator: account.tiktokCreator,
      },
    }),
  }))
}

/** Keys typed into a field or a menu stay there; elsewhere the arrows step through posts. */
const typing = (target: EventTarget) =>
  target instanceof HTMLElement &&
  Boolean(target.closest('input, textarea, [role="combobox"], [role="listbox"], [role="menu"]'))

/**
 * A batch's posts as their platforms show them, one at a time, in a side
 * sheet. The arrows and the ← and → keys step through the posts, and the
 * platform and device chosen stay as they step.
 */
export function BatchPreviewSheet({
  accounts,
  index,
  items,
  onIndexChange,
  options,
}: {
  accounts: readonly BatchAccount[]
  /** The post shown, by its place in `items`; null keeps the sheet closed. */
  index: number | null
  items: readonly BatchItem[]
  onIndexChange: (index: number | null) => void
  options: VersionOptions
}) {
  const [selection, setSelection] = React.useState<PreviewSelection>({
    channel: null,
    device: 'desktop',
  })
  const item = index === null ? undefined : items[index]
  const cards = React.useMemo(
    () => (item ? batchPreviewCards(item, accounts, options) : []),
    [item, accounts, options]
  )
  const step = (by: number) => {
    if (index === null) return
    const next = index + by
    if (next >= 0 && next < items.length) onIndexChange(next)
  }
  const uploading = item?.media.filter((entry) => !entry.assetId).length ?? 0
  // The media rules need every file uploaded; a saved draft is checked in Write.
  const problems =
    item && !uploading && !item.draftId && !waitingToRender(item)
    ? [...stagedChecks(item, [...accounts]).entries()].flatMap(([id, check]) =>
        check.problems.map(
          (problem) => `${accounts.find((account) => account.id === id)?.name}: ${problem}`
        )
      )
    : []
  const caption = (item?.draft?.plainText ?? item?.caption ?? '').trim().split('\n')[0]
  return (
    <Sheet open={Boolean(item)} onOpenChange={(open) => (open ? null : onIndexChange(null))}>
      <SheetContent
        className="w-full gap-0 p-0 sm:max-w-[40rem]"
        data-testid="batch-preview"
        side="right"
        onKeyDown={(event) => {
          if (typing(event.target)) return
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault()
            step(event.key === 'ArrowLeft' ? -1 : 1)
          }
        }}
      >
        <SheetHeader className="border-b border-border pe-14">
          <div className="flex items-center gap-2">
            <Button
              aria-label="Previous post"
              disabled={!index}
              onClick={() => step(-1)}
              size="icon-sm"
              variant="outline"
            >
              <ArrowBackIcon />
            </Button>
            <Button
              aria-label="Next post"
              disabled={index === null || index >= items.length - 1}
              onClick={() => step(1)}
              size="icon-sm"
              variant="outline"
            >
              <ArrowForwardIcon />
            </Button>
            <SheetTitle className="ms-1 text-ui font-medium tabular-nums">
              Post {(index ?? 0) + 1} of {items.length}
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
            <PreviewPanel
              items={cards}
              onSelect={setSelection}
              selection={selection}
              target={null}
            />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
