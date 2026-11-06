'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CHANNEL_META } from '@/components/drafts/channel-meta'
import { measurePieces, PASTE_PIECE_LIMIT } from '@/lib/write/paste-split'
import { SERIES_NAME_LIMIT, suggestedSeriesName } from '@/lib/write/series'
import type { DraftChannel } from '@/lib/write/document'
import { cn } from '@/lib/utils'

/** What a writer can do with a paste that separates into pieces. */
export type PasteChoice = 'posts' | 'thread' | 'one'

/**
 * The choice offered when a paste arrives already separated into pieces:
 * several posts, one thread, or one post as pasted. Each piece shows its
 * length for the platform being written for, so a piece that cannot go out
 * as one post is visible before anything is created.
 *
 * It is the only way into writing a run of posts without building a CSV, so
 * it stays in the new-draft box rather than behind a bulk-tools page.
 */
export function PasteSplit({
  busy,
  channel,
  onChoose,
  pieces,
}: {
  busy: boolean
  /** The platform the lengths are counted for. */
  channel: DraftChannel
  onChoose: (choice: PasteChoice, seriesName: string) => void
  pieces: readonly string[]
}) {
  const [name, setName] = React.useState(() => suggestedSeriesName(pieces[0] ?? ''))
  const measured = measurePieces(pieces, channel)
  const over = measured.filter((piece) => piece.over).length
  const tooMany = pieces.length > PASTE_PIECE_LIMIT
  const label = CHANNEL_META[channel].label
  return (
    <section aria-label="Split this paste" className="grid gap-3" data-testid="paste-split">
      <p className="text-sm">
        That paste separates into {pieces.length} pieces. What should it become?
      </p>
      <ol className="grid max-h-56 gap-1.5 overflow-y-auto" data-testid="paste-pieces">
        {measured.map((piece, index) => (
          <li
            className="flex items-start gap-2 rounded-md border border-border px-2 py-1.5 text-xs"
            data-testid={`paste-piece-${index + 1}`}
            key={index}
          >
            <span className="shrink-0 text-muted-foreground tabular-nums">{index + 1}.</span>
            <span className="min-w-0 flex-1 truncate">{piece.text.replaceAll('\n', ' ')}</span>
            <span
              className={cn(
                'shrink-0 tabular-nums',
                piece.over ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground'
              )}
            >
              {piece.length}
              {piece.over ? ` · over ${label}’s limit` : ''}
            </span>
          </li>
        ))}
      </ol>
      {over > 0 ? (
        <p className="text-xs text-amber-700 dark:text-amber-300" role="status">
          {over} of these {over === 1 ? 'is' : 'are'} past what {label} takes in one post. Create
          them anyway and split each in its own draft, or shorten them here first.
        </p>
      ) : null}
      {tooMany ? (
        <p className="text-xs text-red-700 dark:text-red-300" role="alert">
          A run is at most {PASTE_PIECE_LIMIT} posts. Paste fewer pieces, or keep this as one post
          and split it in the editor.
        </p>
      ) : (
        <Label className="grid gap-1 text-xs text-muted-foreground">
          Name this run, so the queue can move or cancel it as one
          <Input
            aria-label="Series name"
            maxLength={SERIES_NAME_LIMIT}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </Label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="paste-make-posts"
          disabled={busy || tooMany || !name.trim()}
          onClick={() => onChoose('posts', name.trim())}
        >
          Make {pieces.length} posts
        </Button>
        <Button
          data-testid="paste-make-thread"
          disabled={busy || tooMany}
          onClick={() => onChoose('thread', name.trim())}
          variant="outline"
        >
          Make a thread
        </Button>
        <Button
          data-testid="paste-keep-one"
          disabled={busy}
          onClick={() => onChoose('one', name.trim())}
          variant="ghost"
        >
          Keep as one
        </Button>
      </div>
    </section>
  )
}
