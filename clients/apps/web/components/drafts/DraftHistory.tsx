'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { LocalTime, WHEN_STYLE } from '@/components/drafts/local-time'
import { relativeTime } from '@/components/workflows/workflow-ui'
import type { DraftActivitySource } from '@/lib/api/contracts/write'
import { type DraftActivityWire, writeApi } from '@/lib/write/client'
import { groupHistory } from '@/lib/write/history'

/** An activity event's action as a person reads it. */
const ACTIONS: Record<string, string> = {
  'post.automations_cancelled': 'Cancelled a post’s follow-ups',
  'post.cancelled': 'Cancelled a post',
  'post.moved': 'Moved a post',
  'post.publish_failed': 'A post failed',
  'post.publish_now': 'Published a post now',
  'post.publish_recovery_required': 'A post’s outcome is unknown',
  'post.publish_requeued': 'Queued a post again',
  'post.published': 'Published a post',
  'post.reconciled_live': 'Marked a post as live',
  'post.reconciled_not_live': 'Marked a post as not published',
  'post.retried': 'Retried a destination',
  'post.scheduled': 'Queued a post',
  'post.thread_resumed': 'Posted the rest of a thread',
  'product.content_draft_comment_add': 'Commented',
  'product.content_draft_comment_delete': 'Deleted a comment',
  'product.content_draft_comment_delete_thread': 'Deleted a discussion',
  'product.content_draft_comment_edit': 'Edited a comment',
  'product.content_draft_comment_resolve': 'Resolved a discussion',
  'product.content_draft_created': 'Created the draft',
  'product.content_draft_deleted': 'Deleted the draft',
  'product.content_draft_planned': 'Changed the plan',
  'product.content_draft_properties_updated': 'Organized the draft',
  'product.content_draft_recovered': 'Recovered a backup as a new draft',
  'product.content_draft_review': 'Review step',
  'product.content_draft_scheduled': 'Scheduled',
  'product.content_draft_shared': 'Changed sharing',
  'product.content_draft_updated': 'Edited',
}

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

/** The action as a person reads it. */
function actionLabel(item: DraftActivityWire): string {
  return ACTIONS[item.action] ?? item.action.replace(/^product\./, '').replaceAll('_', ' ')
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
  return (
    <p className="text-foreground">
      {actionLabel(item)}
      {detail(item) ? <span className="text-muted-foreground"> · {detail(item)}</span> : null}
    </p>
  )
}

/** When a change happened: how long ago, and the moment itself. */
function When({ at }: { at: string }) {
  return (
    <>
      {relativeTime(at)} · <LocalTime value={at} />
    </>
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
  React.useEffect(() => {
    let active = true
    setFailed(false)
    void writeApi
      .activity(draftId)
      .then((page) => {
        if (!active) return
        setItems(page.items)
        setNext(page.nextCursor)
      })
      .catch(() => {
        if (!active) return
        setItems([])
        setFailed(true)
      })
    return () => {
      active = false
    }
  }, [draftId, version])
  const older = async () => {
    if (!next) return
    setLoadingOlder(true)
    try {
      const page = await writeApi.activity(draftId, next)
      setItems((current) => [...(current ?? []), ...page.items])
      setNext(page.nextCursor)
    } catch {
      setFailed(true)
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
