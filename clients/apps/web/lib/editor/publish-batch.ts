'use client'

import type { TRPCClient } from '@trpc/client'
import {
  BATCH_ITEM_LIMIT,
  type BatchItemInput,
  type ContentBatch,
} from '@/lib/api/contracts/content-batches'
import { DRAFT_ACCOUNT_LIMIT } from '@/lib/api/contracts/content-drafts'
import { call } from '@/lib/content-drafts/client'
import type { AppRouter } from '@/lib/trpc/router'
import { saveExportToWorkspace } from '@/lib/workspace/save-export'
import { exportFileName } from './publish-drafts'

/**
 * Editor batch exports as a bulk batch (RFC 042).
 *
 * Batch export already renders one design over many screenshots; bulk
 * publishing already turns a list of media into drafts with captions, times
 * and accounts. This joins them: every rendered screenshot is stored as a
 * workspace asset and staged as its own item, then the batch page owns the
 * rest, including its caption tools, CSV import, queue times and scheduling.
 *
 * Each item keeps its source file name, so a caption CSV naming those files
 * matches the posts they became (`matchCaptions`).
 */

/** One rendered export to stage: the bytes and the screenshot they came from. */
export type BatchExport = { blob: Blob; name: string }

/** Where the staged posts go. */
export type StageBatchRequest = {
  /** The accounts every staged post starts with; the batch page can change them. */
  channelConnectionIds: string[]
  exports: readonly BatchExport[]
  /** Reports uploads as they finish, for a busy label. */
  onProgress?: (done: number, total: number) => void
  socialSetId: string
  title: string
  trpcClient: TRPCClient<AppRouter>
}

/**
 * Stage every export as a post of a new batch and answer the batch.
 *
 * Uploads run before the batch is created, so a failed upload leaves no
 * half-filled batch behind; the items are then staged in one request, which
 * the API applies as a whole. An upload that did finish is a workspace
 * asset either way, and stays in the Library.
 */
export async function stageExportsAsBatch(request: StageBatchRequest): Promise<ContentBatch> {
  if (request.exports.length === 0) throw new Error('Render the screenshots first.')
  if (request.exports.length > BATCH_ITEM_LIMIT)
    throw new Error(`A batch holds up to ${BATCH_ITEM_LIMIT} posts.`)
  if (request.channelConnectionIds.length > DRAFT_ACCOUNT_LIMIT)
    throw new Error(`One post goes to at most ${DRAFT_ACCOUNT_LIMIT} accounts.`)
  const items: BatchItemInput[] = []
  for (const [index, entry] of request.exports.entries()) {
    request.onProgress?.(index, request.exports.length)
    const { assetId } = await saveExportToWorkspace({
      blob: entry.blob,
      classification: 'export',
      fileName: exportFileName(entry.name, entry.blob.type),
      trpcClient: request.trpcClient,
    })
    items.push({
      caption: '',
      channelConnectionIds: request.channelConnectionIds,
      importKey: `editor-batch-${crypto.randomUUID()}`,
      media: [{ assetId }],
      sourceKey: entry.name.slice(0, 255),
      timing: {},
    })
  }
  request.onProgress?.(request.exports.length, request.exports.length)
  const batch = await call<ContentBatch>('/api/v1/content-batches', {
    body: { socialSetId: request.socialSetId, title: request.title },
    method: 'POST',
  })
  return call<ContentBatch>(`/api/v1/content-batches/${encodeURIComponent(batch.id)}/items`, {
    body: { items },
    method: 'POST',
  })
}
