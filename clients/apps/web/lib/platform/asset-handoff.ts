import { contentDraftIdSchema } from '@/lib/api/contracts/content-drafts'
import type { PlateBody } from '@/lib/write/document'
import { postBreak } from '@/lib/write/versions'

const IMAGES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const VIDEOS = new Set(['video/mp4', 'video/quicktime', 'video/webm'])

/** The writing editor's existing native media formats. */
export function supportedDraftMedia(mediaType: string): boolean {
  return IMAGES.has(mediaType) || VIDEOS.has(mediaType)
}

/** Keep the asset reference, not an expiring signed URL or a downloaded copy. */
export function draftAssetNode(asset: { id: string; mediaType: string }) {
  const id = contentDraftIdSchema.parse(asset.id)
  if (!supportedDraftMedia(asset.mediaType))
    throw new Error('Export this asset to a supported image or video format first.')
  return {
    type: IMAGES.has(asset.mediaType) ? 'img' : 'video',
    assetId: id,
    // The stored type lets the composer check each destination's formats.
    mimeType: asset.mediaType,
    url: `/api/v1/assets/${encodeURIComponent(id)}/content`,
    children: [{ text: '' }],
  }
}

/** One attachment a studio hands to a post, with the alt text it already knows. */
export type DraftPostMedia = { alt?: string; id: string; mediaType: string }

/**
 * The body of a post made from studio output: one post holding the caption
 * and its attachments, in order.
 *
 * Every studio that starts a post from what it rendered (the screenshot
 * editor, Code Studio) builds the same shape, and a post break gives that
 * post the identity and settings the composer edits it with.
 */
export function draftPostBody(input: { caption?: string; media: DraftPostMedia[] }): PlateBody {
  return [
    postBreak(),
    { type: 'p', children: [{ text: input.caption ?? '' }] },
    ...input.media.map((media) =>
      media.alt === undefined
        ? draftAssetNode(media)
        : { ...draftAssetNode(media), alt: media.alt }
    ),
  ] as PlateBody
}
