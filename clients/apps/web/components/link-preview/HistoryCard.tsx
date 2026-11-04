'use client'

import { formatDistanceToNow } from 'date-fns'
import { ClockCounterClockwiseIcon as History } from '@phosphor-icons/react/dist/ssr/ClockCounterClockwise'
import { type LinkPreviewSnapshot, snapshotChanges } from '@/lib/link-preview/history'
import { cn } from '@/lib/utils'
import { PANEL } from './MetadataPanels'

const clip = (value?: string) =>
  value ? (value.length > 90 ? `${value.slice(0, 89)}…` : value) : 'Not set'

/** This link's earlier checks in this browser: the score over time and what changed since the last one. */
export function HistoryCard({ entries }: { entries: LinkPreviewSnapshot[] }) {
  const [latest, previous] = entries
  if (!latest) return null
  if (!previous) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <History className="size-3.5" />
        First check of this link in this browser. Check it again after a change to see what moved.
      </p>
    )
  }
  const changes = snapshotChanges(previous, latest)
  const delta = latest.score - previous.score
  const scores = entries.slice(0, 10).reverse()
  return (
    <section className={cn(PANEL, 'space-y-4 p-5')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-ui-lg font-medium text-foreground">
          <History className="size-4" />
          Since your last check {formatDistanceToNow(previous.at, { addSuffix: true })}
        </h3>
        <span
          className={cn(
            'text-ui-lg font-medium tabular-nums',
            delta > 0 ? 'text-emerald-400' : delta < 0 ? 'text-red-400' : 'text-muted-foreground'
          )}
        >
          Score {previous.score} → {latest.score}
          {delta ? ` (${delta > 0 ? '+' : ''}${delta})` : ''}
        </span>
      </div>
      <div className="flex h-12 items-end gap-1" aria-label="Score history" role="img">
        {scores.map((entry) => (
          <span
            key={entry.at}
            title={`${entry.score} · ${new Date(entry.at).toLocaleString()}`}
            className={cn(
              'w-3 rounded-sm',
              entry.score >= 80
                ? 'bg-emerald-500/70'
                : entry.score >= 50
                  ? 'bg-amber-500/70'
                  : 'bg-red-500/70'
            )}
            style={{ height: `${Math.max(8, entry.score)}%` }}
          />
        ))}
      </div>
      {changes.length ? (
        <ul className="space-y-2 text-sm">
          {changes.map((change) => (
            <li key={change.label} className="grid gap-1 sm:grid-cols-[9rem_1fr]">
              <span className="text-muted-foreground">{change.label}</span>
              <span className="min-w-0 break-words">
                <span className="text-red-300/80 line-through">{clip(change.before)}</span>
                <span className="text-muted-foreground"> → </span>
                <span className="text-emerald-300">{clip(change.after)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No tag that decides the preview has changed.
        </p>
      )}
    </section>
  )
}
