import 'server-only'

import type {
  BackendContentBatch,
  BackendContentBatchItem,
  BackendContentBatchItemInput,
  BackendContentDraftCreate,
  BackendContentDraftScheduleTarget,
} from 'screenshot-studio-backend-sdk'
import type { OrganizationAccess } from '@/lib/auth/access'
import { backendSDK, orNull, withDates } from '@/lib/backend/sdk'
import { draftTargets, readPost } from '@/lib/tenant/content-drafts'
import { ScheduledPostError } from '@/lib/tenant/scheduled-posts'

/**
 * Bulk batches (RFC 042). The backend owns batches, their items and the
 * gates; this module adds what only the web can do: serialize each item's
 * draft for each account with the composer's builder.
 */

/** An item with its posts' times as Dates. */
function readItem(item: BackendContentBatchItem) {
  return { ...item, posts: item.posts.map(readPost) }
}

/** A batch with its timestamps and its items' post times as Dates. */
function readBatch(batch: BackendContentBatch) {
  return { ...withDates(batch), items: batch.items?.map(readItem) }
}

/** Open batches in the sets this member can see. */
export async function listContentBatches(context: OrganizationAccess) {
  const { batches } = await backendSDK(context).listContentBatches()
  return { batches: batches.map(readBatch) }
}

/** Start a batch in a social set (the default set when omitted). */
export async function createContentBatch(
  context: OrganizationAccess,
  input: { socialSetId?: string; title: string }
) {
  return readBatch(await backendSDK(context).createContentBatch(input))
}

/** A batch with its items, media facts, drafts and posts; null when it is not visible. */
export async function getContentBatch(context: OrganizationAccess, id: string) {
  const batch = await orNull(backendSDK(context).getContentBatch(id))
  return batch ? readBatch(batch) : null
}

/** Stage items; a retried key returns its item. */
export async function addContentBatchItems(
  context: OrganizationAccess,
  id: string,
  items: BackendContentBatchItemInput[]
) {
  return readBatch(await backendSDK(context).addContentBatchItems(id, items))
}

/** Change a staged item, or a drafted item's time and position. */
export async function updateContentBatchItem(
  context: OrganizationAccess,
  id: string,
  itemId: string,
  input: Parameters<ReturnType<typeof backendSDK>['updateContentBatchItem']>[2]
) {
  return readItem(await backendSDK(context).updateContentBatchItem(id, itemId, input))
}

/** Change many items as one operation: a refused item refuses them all. */
export async function updateContentBatchItems(
  context: OrganizationAccess,
  id: string,
  items: Parameters<ReturnType<typeof backendSDK>['updateContentBatchItems']>[1]
) {
  return readBatch(await backendSDK(context).updateContentBatchItems(id, items))
}

/** Save an item as its draft; a retry returns the same draft. */
export async function createContentBatchItemDraft(
  context: OrganizationAccess,
  id: string,
  itemId: string,
  input: BackendContentDraftCreate
) {
  return readItem(await backendSDK(context).createContentBatchItemDraft(id, itemId, input))
}

/** The result of one item and account. */
type Verdict = {
  channelConnectionId: string
  error?: string
  itemId: string
  scheduledFor: string | null
  timeZone: string
  valid: boolean
}

/**
 * Check every requested item and account apart: the payload the composer
 * would publish, then the backend's scheduling gates for that payload and the
 * item's intended time. Nothing is charged, reserved or published. Null when
 * the batch is not visible.
 */
export async function validateContentBatch(
  context: OrganizationAccess,
  id: string,
  items: { itemId: string; channelConnectionIds: string[] }[]
) {
  const batch = await orNull(backendSDK(context).getContentBatch(id))
  if (!batch) return null
  const byId = new Map((batch.items ?? []).map((item) => [item.id, item]))
  const verdicts: Verdict[] = []
  const rows: { itemId: string; targets: BackendContentDraftScheduleTarget[]; version: number }[] =
    []
  for (const request of items) {
    const item = byId.get(request.itemId)
    if (!item) throw new ScheduledPostError('A selected item is not in this batch.', 404)
    const refuse = (channelConnectionId: string, error: string) =>
      verdicts.push({
        channelConnectionId,
        error,
        itemId: item.id,
        scheduledFor: null,
        timeZone: batch.timeZone,
        valid: false,
      })
    if (!item.draftId) {
      for (const channel of request.channelConnectionIds)
        refuse(channel, 'Save this item as a draft first.')
      continue
    }
    const built = await draftTargets(context, item.draftId, request.channelConnectionIds)
    if (!built) {
      for (const channel of request.channelConnectionIds)
        refuse(channel, 'This item’s draft is no longer available.')
      continue
    }
    const targets: BackendContentDraftScheduleTarget[] = []
    for (const entry of built) {
      if (!entry.target || entry.problems.length > 0)
        refuse(entry.channelConnectionId, entry.problems.join(' '))
      else targets.push(entry.target)
    }
    if (targets.length > 0) rows.push({ itemId: item.id, targets, version: built[0].version })
  }
  if (rows.length > 0) {
    const { results } = await backendSDK(context).validateContentBatch(id, rows)
    verdicts.push(...results)
  }
  return { results: verdicts }
}
