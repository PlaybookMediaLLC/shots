'use client'

import type { TRPCClient } from '@trpc/client'
import type { DesignCopy } from '@/lib/captions/channels'
import { call, draftsApi, type DraftWire } from '@/lib/content-drafts/client'
import type { DesignDocument } from '@/lib/design/document'
import { renderDocument } from '@/lib/render/scene-renderer'
import type { AppRouter } from '@/lib/trpc/router'
import type { DraftChannel } from '@/lib/write/document'
import { safeAssetFileName, saveExportToWorkspace } from '@/lib/workspace/save-export'
import {
  captionChannelText,
  captionFor,
  designMediaProblems,
  designPostBody,
  primaryFor,
} from './publish'

/**
 * Turning editor designs into Publish drafts, in the browser.
 *
 * One design becomes one draft: the design is rendered by the editor's own
 * stage (so the post shows exactly what the canvas shows), stored as a
 * workspace asset with the design's alt text, and opened as a draft whose
 * body is the primary platform's caption and whose other platforms keep the
 * captions written for them.
 *
 * Several designs become several drafts, one each, left for review rather
 * than scheduled: that is what the AI Variants panel hands over.
 */

/**
 * The editor's default still export (`DEFAULT_EXPORT_SETTINGS`): a
 * high-quality JPEG at twice the canvas size. The post then carries the
 * image people would have downloaded and attached by hand, at a size every
 * platform's byte limit takes.
 */
const OUTPUT = { format: 'jpeg', quality: 'high', scale: 2 } as const

/** What a published export is, for callers checking a platform's rules first. */
export const PUBLISH_MEDIA_TYPE = 'image/jpeg'

/** A draft's title limit, as `contentDraftFieldsSchema` sets it. */
const TITLE_LIMIT = 200

/** One design to post: its document and a name for its file and draft. */
export type PublishDesign = { document: DesignDocument; name: string }

/**
 * A stored file name for an export: the design's own name, made safe for an
 * object key and given the extension the bytes actually have. A name with
 * nothing to keep falls back to a stamped one, as a plain export does.
 */
export function exportFileName(name: string, contentType: string): string {
  const extension = contentType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
  const stem = safeAssetFileName(name).replace(/\.[^.]+$/, '')
  return `${stem || `shots-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`}.${extension}`
}

/** Where the drafts go and what they say. */
export type PublishRequest = {
  /** The connection ids of the accounts the drafts are aimed at. */
  channelConnectionIds: string[]
  /** The platforms whose captions the drafts carry. */
  channels: DraftChannel[]
  /** The alt text and per-platform captions from the Captions panel. */
  copy: DesignCopy | null
  designs: readonly PublishDesign[]
  /** A calendar placement for every draft, as an ISO instant. */
  plannedFor?: string
  socialSetId?: string
  trpcClient: TRPCClient<AppRouter>
  /** Reports progress as each design is prepared, for a busy label. */
  onProgress?: (done: number, total: number) => void
}

/**
 * Create one draft per design, in order. Each design is finished before the
 * next starts and the run stops at the first failure, so what came back is
 * always a prefix of `designs`: a caller can continue from there instead of
 * making the first ones twice.
 */
export async function publishDesigns(
  request: PublishRequest
): Promise<{ drafts: DraftWire[]; error?: string }> {
  const primary = primaryFor(request.channels, request.copy)
  const caption = captionFor(request.copy, primary)
  const channelText = captionChannelText(request.copy, request.channels, primary)
  const altText = request.copy?.altText?.trim()
  const drafts: DraftWire[] = []
  for (const [index, design] of request.designs.entries()) {
    request.onProgress?.(index, request.designs.length)
    try {
      const { blob, height, width } = await renderDocument(design.document, OUTPUT)
      // The same media rules Go schedules with, on the bytes that were
      // actually produced: a post that no chosen platform can take is never
      // uploaded or drafted.
      const problems = designMediaProblems(request.channels, {
        bytes: blob.size,
        height,
        mimeType: blob.type,
        width,
      })
      if (problems.length > 0) throw new Error(problems.join(' '))
      const { assetId } = await saveExportToWorkspace({
        blob,
        classification: 'export',
        fileName: exportFileName(design.name, blob.type),
        trpcClient: request.trpcClient,
      })
      if (altText) {
        await call(`/api/v1/assets/${encodeURIComponent(assetId)}/alt-text`, {
          body: { altText },
          method: 'PUT',
        })
      }
      const draft = await draftsApi.create({
        assetIds: [assetId],
        body: designPostBody({
          altText,
          assets: [{ id: assetId, mediaType: blob.type }],
          caption,
        }),
        channelConnectionIds: request.channelConnectionIds,
        channelText,
        plainText: caption,
        primaryPlatform: primary,
        requestKey: crypto.randomUUID(),
        ...(request.socialSetId ? { socialSetId: request.socialSetId } : {}),
        title: design.name.slice(0, TITLE_LIMIT),
      })
      // Counted from here on: the draft exists, so a retry must not make it
      // again even if its calendar placement fails.
      drafts.push(draft)
      if (request.plannedFor) {
        drafts[drafts.length - 1] = await draftsApi.save(draft.id, {
          baseVersion: draft.version,
          plannedFor: request.plannedFor,
        })
      }
    } catch (error) {
      return {
        drafts,
        error: error instanceof Error ? error.message : 'The draft could not be created.',
      }
    }
  }
  request.onProgress?.(request.designs.length, request.designs.length)
  return { drafts }
}
