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
import { CHANNEL_META } from '@/components/drafts/channel-meta'
import {
  type BatchAccount,
  feedPublications,
  itemAccounts,
  previewPublications,
  stagedChecks,
  waitingToRender,
} from '@/lib/write/batch'
import type { VersionOptions } from '@/lib/write/document'
import {
  PreviewFeed,
  PreviewPanel,
  type PreviewSelection,
  PreviewToolbar,
} from '../composer/preview'
import { Segmented } from './Segmented'

/** Keys pressed in the device menu or on a video stay there; elsewhere the arrows step through posts. */
const ownsArrows = (target: EventTarget) =>
  target instanceof HTMLElement &&
  Boolean(target.closest('video, audio, [role="combobox"], [role="listbox"]'))

/**
 * A batch's posts as their platforms show them, in a side sheet: one at a
 * time, or all of them as one platform's feed, in list order. The arrows
 * and the ← and → keys step through the posts, and the platform and device
 * chosen stay as they step and between the two views. The post is followed by
 * its id, so a list that changes underneath never shows another post.
 */
export function BatchPreviewSheet({
  accounts,
  itemId,
  items,
  onItemChange,
  options,
  zone,
}: {
  accounts: readonly BatchAccount[]
  /** The post shown; null keeps the sheet closed. */
  itemId: string | null
  items: readonly BatchItem[]
  onItemChange: (itemId: string | null) => void
  options: VersionOptions
  /** The batch's time zone, which the feed's times are in. */
  zone: string
}) {
  const [mode, setMode] = React.useState<'post' | 'feed'>('post')
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
  // The feed offers each platform the batch goes to, through its first account there.
  const used = new Set(items.flatMap(itemAccounts))
  const channels = accounts.filter(
    (account, at, all) =>
      used.has(account.id) &&
      all.findIndex((other) => used.has(other.id) && other.channel === account.channel) === at
  )
  // With no platform picked, the feed opens on the one the post on screen shows.
  const feedChannel =
    channels.find((account) => account.channel === selection.channel)?.channel ??
    channels.find((account) => account.channel === preview.cards[0]?.account.channel)?.channel ??
    channels[0]?.channel
  const feed = React.useMemo(
    () =>
      mode === 'feed' && feedChannel
        ? feedPublications(items, accounts, options, feedChannel, zone)
        : { posts: [], refused: 0 },
    [mode, feedChannel, items, accounts, options, zone]
  )
  return (
    <Sheet
      open={Boolean(item)}
      onOpenChange={(open) => {
        if (open) return
        setMode('post')
        onItemChange(null)
      }}
    >
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
          if (mode !== 'post' || ownsArrows(event.target)) return
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
            {mode === 'post' ? (
              <>
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
              </>
            ) : null}
            <SheetTitle aria-live="polite" className="ms-1 text-ui font-medium tabular-nums">
              {mode === 'post' ? `Post ${index + 1} of ${items.length}` : 'Feed'}
            </SheetTitle>
            <div className="ms-auto">
              <Segmented
                label="Preview"
                onChange={setMode}
                options={[
                  ['post', 'One post'],
                  ['feed', 'Feed'],
                ]}
                value={mode}
              />
            </div>
          </div>
          <SheetDescription className="truncate">
            {mode === 'post'
              ? caption || 'No caption'
              : feedChannel
                ? `${feed.posts.length + feed.refused} of ${items.length} posts go to ${CHANNEL_META[feedChannel].label}, in list order.`
                : 'No post goes to an account yet.'}
          </SheetDescription>
        </SheetHeader>
        {item && mode === 'feed' ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" data-testid="batch-feed">
            <p className="rounded-md border border-dashed border-input px-2 py-1 text-center text-[11px] text-muted-foreground">
              Preview — not published
            </p>
            {feedChannel ? (
              <PreviewToolbar
                accounts={channels}
                active={feedChannel}
                onSelect={setSelection}
                selection={selection}
              />
            ) : null}
            {feed.posts.length ? (
              <PreviewFeed
                device={selection.device}
                onOpen={(key) => {
                  // The post opens on the platform the feed shows.
                  setSelection({ ...selection, channel: feedChannel ?? null })
                  setMode('post')
                  onItemChange(key)
                }}
                posts={feed.posts}
              />
            ) : null}
            {feed.refused ? (
              <p className="text-label text-destructive">
                {feed.refused} post{feed.refused === 1 ? '' : 's'} cannot be shown. Open them one
                by one to see why.
              </p>
            ) : null}
            <p className="text-[11px] text-muted-foreground">
              Files still uploading show once uploaded. Cutoffs vary by app and device.
            </p>
          </div>
        ) : item ? (
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
