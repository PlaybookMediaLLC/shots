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

/**
 * The draft an editor was opened from, read from an editor URL's `fromDraft`.
 * Null when the parameter is missing or is not a draft identifier, so a
 * hand-edited return address cannot send an export somewhere else.
 */
export function returnDraftId(search: string): string | null {
  const asked = new URLSearchParams(search).get('fromDraft')
  return asked && contentDraftIdSchema.safeParse(asked).success ? asked : null
}

/**
 * Where an export returns to the draft it was opened from: the composer opens
 * it for review and attaches it only when the person says so. The media type
 * travels with it so the composer can check each destination's formats; the
 * backend validates both the asset and the type again when the draft is
 * scheduled.
 */
export function attachToDraftHref(draftId: string, asset: { id: string; mediaType: string }) {
  const query = new URLSearchParams({ attach: asset.id, attachType: asset.mediaType })
  return `/publish/${encodeURIComponent(draftId)}?${query}`
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
