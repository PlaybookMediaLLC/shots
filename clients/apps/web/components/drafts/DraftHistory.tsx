'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { LocalTime, WHEN_STYLE } from '@/components/drafts/local-time'
import { relativeTime } from '@/components/workflows/workflow-ui'
import type { DraftActivitySource } from '@/lib/api/contracts/write'
import { type DraftActivityWire, writeApi } from '@/lib/write/client'
import { actionLabel, groupHistory } from '@/lib/write/history'

/** Who made a change when no person did. */
const SOURCES: Record<DraftActivitySource, string> = {
  api: 'API key',
  automation: 'Shots',
  callback: 'Provider callback',
  mcp: 'AI agent (MCP)',
  person: 'A former member',
  support: 'Shots support',
  workflow: 'Publishing',
}

/** What an event changed, from its references. */
function detail(item: DraftActivityWire): string {
  const metadata = item.metadata
  const changed = Array.isArray(metadata.changed) ? (metadata.changed as string[]) : []
  if (changed.length > 0) return changed.join(', ').replaceAll('_', ' ')
  if (typeof metadata.enabled === 'boolean')
    return metadata.enabled ? 'public link on' : 'public link off'
  if (metadata.cleared) return 'plan cleared'
  if (typeof metadata.plannedFor === 'string')
    return `for ${new Date(metadata.plannedFor).toLocaleString(undefined, WHEN_STYLE)}`
  if (typeof metadata.reason === 'string' && metadata.reason !== 'schedule') return metadata.reason
  if (typeof metadata.action === 'string') return metadata.action
  return ''
}

/** One change: what happened and what it touched. */
function Change({ item }: { item: DraftActivityWire }) {
  const touched = detail(item)
  return (
    <p className="text-foreground">
      {actionLabel(item)}
      {touched ? <span className="text-muted-foreground"> · {touched}</span> : null}
    </p>
  )
}

const WEEK_MS = 7 * 86_400_000

/**
 * When a change happened: how long ago within a week, and the moment itself.
 * A server clock ahead of the reader's still reads as now, not the future.
 */
function When({ at }: { at: string }) {
  const age = Date.now() - new Date(at).getTime()
  return (
    <span data-testid="activity-when">
      {age < WEEK_MS ? `${relativeTime(age > 0 ? at : new Date().toISOString())} · ` : null}
      <LocalTime value={at} />
    </span>
  )
}

/**
 * A draft's history, newest first: consecutive changes by one author are one
 * entry that opens to list each change. Older pages load on request. Reading
 * it records nothing.
 */
export function DraftHistory({ draftId, version }: { draftId: string; version?: number }) {
  const [items, setItems] = React.useState<DraftActivityWire[] | null>(null)
  const [next, setNext] = React.useState<string | null>(null)
  const [failed, setFailed] = React.useState(false)
  const [loadingOlder, setLoadingOlder] = React.useState(false)
  // Each reload starts a new generation; an older page from a previous one is dropped.
  const generation = React.useRef(0)
  React.useEffect(() => {
    const current = ++generation.current
    setFailed(false)
    void writeApi
      .activity(draftId)
      .then((page) => {
        if (generation.current !== current) return
        setItems(page.items)
        setNext(page.nextCursor)
      })
      .catch(() => {
        if (generation.current !== current) return
        setItems([])
        setNext(null)
        setFailed(true)
      })
  }, [draftId, version])
  const older = async () => {
    if (!next) return
    const current = generation.current
    setLoadingOlder(true)
    setFailed(false)
    try {
      const page = await writeApi.activity(draftId, next)
      if (generation.current !== current) return
      setItems((loaded) => [...(loaded ?? []), ...page.items])
      setNext(page.nextCursor)
    } catch {
      if (generation.current === current) setFailed(true)
    } finally {
      setLoadingOlder(false)
    }
  }
  const groups = React.useMemo(() => groupHistory(items ?? []), [items])
  return (
    <div className="grid gap-2">
      {items === null ? <p className="text-xs text-muted-foreground">Loading…</p> : null}
      {failed ? (
        <p className="text-xs text-red-700 dark:text-red-300" role="alert">
          The activity could not be loaded.
        </p>
      ) : null}
      <ol className="grid gap-2" data-testid="activity">
        {groups.map(({ id, items: changes }) => {
          const [latest] = changes
          if (!latest) return null
          return (
            <li className="text-xs" data-testid="activity-group" key={id}>
              <Change item={latest} />
              <p className="text-label text-muted-foreground">
                <span data-testid="activity-author">
                  {latest.source === 'person'
                    ? (latest.actorName ?? SOURCES.person)
                    : SOURCES[latest.source]}
                </span>{' '}
                · <When at={latest.at} />
              </p>
              {changes.length > 1 ? (
                <Disclosure>
                  <DisclosureTrigger className="mt-1 text-xs text-muted-foreground">
                    {changes.length} changes
                  </DisclosureTrigger>
                  <DisclosureContent className="grid gap-1 pt-1 pl-5">
                    {changes.map((change) => (
                      <div key={change.id}>
                        <Change item={change} />
                        <p className="text-label text-muted-foreground">
                          <When at={change.at} />
                        </p>
                      </div>
                    ))}
                  </DisclosureContent>
                </Disclosure>
              ) : null}
            </li>
          )
        })}
      </ol>
      {next ? (
        <Button
          className="justify-self-start"
          disabled={loadingOlder}
          onClick={() => void older()}
          size="sm"
          variant="ghost"
        >
          {loadingOlder ? 'Loading…' : 'Show older activity'}
        </Button>
      ) : null}
    </div>
  )
}
