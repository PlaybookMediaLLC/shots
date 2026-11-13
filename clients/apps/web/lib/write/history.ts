import type { DraftActivityWire } from '@/lib/write/client'

/** The longest gap between two changes by one author that still groups them. */
export const HISTORY_GROUP_GAP_MS = 30 * 60 * 1000

/** Consecutive changes by one author, newest first. */
export type HistoryGroup = { id: string; items: DraftActivityWire[] }

/** Who made a change: the person, or the key, workflow or service when no person did. */
function author(item: DraftActivityWire): string {
  return item.actorUserId ? `person:${item.actorUserId}` : `source:${item.source}`
}

/**
 * Groups a history read newest first: a change joins the group above it when
 * the same author made it within {@link HISTORY_GROUP_GAP_MS} of that group's
 * oldest change. The same events always make the same groups.
 */
export function groupHistory(items: DraftActivityWire[]): HistoryGroup[] {
  const groups: HistoryGroup[] = []
  for (const item of items) {
    const group = groups.at(-1)
    const oldest = group?.items.at(-1)
    if (
      group &&
      oldest &&
      author(oldest) === author(item) &&
      new Date(oldest.at).getTime() - new Date(item.at).getTime() <= HISTORY_GROUP_GAP_MS
    )
      group.items.push(item)
    else groups.push({ id: item.id, items: [item] })
  }
  return groups
}

/** An activity event's action as a person reads it. */
const ACTIONS: Record<string, string> = {
  'post.automations_cancelled': 'Cancelled a post’s follow-ups',
  'post.cancelled': 'Cancelled a post',
  'post.moved': 'Moved a post',
  'post.publish_failed': 'A post failed',
  'post.publish_now': 'Queued a post to publish now',
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

/** The action as a person reads it. */
export function actionLabel(item: DraftActivityWire): string {
  if (item.action === 'product.content_draft_comment_resolve' && item.metadata.resolved === false)
    return 'Reopened a discussion'
  return ACTIONS[item.action] ?? item.action.replace(/^product\./, '').replaceAll('_', ' ')
}
