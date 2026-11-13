import { z } from 'zod'
import limits from '../../../../../server/internal/medialimits/limits.json'
import { draftChannelSchema, type DraftChannel } from '@/lib/write/document'

/**
 * Each destination's media rules (RFC 042), read from the same file Go
 * checks scheduling with (`checkDraftMedia` in
 * server/internal/product/content_draft_media.go), so the composer and the
 * backend refuse the same combinations with the same words. Account limits
 * (an X subscription, a Mastodon server, Bluesky upload rights) are checked
 * by the backend against the account's verified capabilities.
 */
const rulesSchema = z.object({
  maxMedia: z.number().int().positive(),
  requiresMedia: z.boolean().optional(),
  mixed: z.boolean(),
  images: z.array(z.string()),
  converts: z.record(z.string(), z.string()).optional(),
  imageMaxBytes: z.number().int().positive().optional(),
  minImageWidth: z.number().int().positive().optional(),
  aspect: z.object({ min: z.number(), max: z.number() }).optional(),
  gif: z.object({ alone: z.boolean(), maxBytes: z.number().int().positive() }).optional(),
  video: z
    .object({
      formats: z.array(z.string()),
      alone: z.boolean(),
      minMs: z.number().int().optional(),
      maxMs: z.number().int().optional(),
      maxBytes: z.number().int().positive(),
    })
    .optional(),
  /** The image a video post takes as its cover or thumbnail. */
  cover: z
    .object({ formats: z.array(z.string()), maxBytes: z.number().int().positive() })
    .optional(),
  docs: z.array(z.url()),
  verifiedOn: z.string(),
})

const destinationSchema = rulesSchema.extend({
  /** What one story takes, where the destination has stories. */
  story: rulesSchema.optional(),
})

/** One destination's media rules. */
export type DestinationMedia = z.infer<typeof destinationSchema>

/** Every draft channel's media rules, with the provider pages they come from. */
export const DESTINATION_MEDIA: Record<DraftChannel, DestinationMedia> = z
  .record(draftChannelSchema, destinationSchema)
  .parse(limits.destinations)

/** What Shots knows of one attachment; unknown facts are left to the backend. */
export type MediaFacts = {
  bytes?: number
  durationMs?: number | null
  height?: number | null
  /** The stored type; `image/*` or `video/*` when only the kind is known. */
  mimeType: string
  width?: number | null
}

/** Each platform's name as people write it. */
export const LABELS: Record<DraftChannel, string> = {
  bluesky: 'Bluesky',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  mastodon: 'Mastodon',
  threads: 'Threads',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  x: 'X',
  facebook: 'Facebook',
  pinterest: 'Pinterest',
  gmb: 'Google Business',
}

/** Formats as people know them: JPEG, PNG, MP4, MOV. */
function formatNames(types: string[]) {
  return types
    .map((value) => {
      const name = value.replace(/^(image|video)\//, '').toUpperCase()
      return name === 'QUICKTIME' ? 'MOV' : name
    })
    .join(', ')
}

/** The shapes platforms ask for, named as people know them. */
const SHAPES = [
  ['9:16', 9 / 16],
  ['4:5', 4 / 5],
  ['1:1', 1],
  ['16:9', 16 / 9],
] as const

/** A picture's shape: a known ratio when it is within 3%, else its size. */
export function shapeName(width: number, height: number): string {
  const ratio = width / height
  return SHAPES.find(([, known]) => Math.abs(ratio / known - 1) < 0.03)?.[0] ?? `${width}×${height}`
}

/** A duration as minutes and seconds, such as 2:05. */
export function clock(ms: number) {
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** A channel's story as Go names it (`storyLabel`): "An Instagram story". */
function storyLabel(channel: DraftChannel): string {
  return `${/^[AEIOU]/.test(LABELS[channel]) ? 'An' : 'A'} ${LABELS[channel]} story`
}

/**
 * Why one post's attachments, in order, cannot go to a channel, as the
 * backend words it; empty when they can. Only known facts are checked.
 */
export function mediaProblems(
  channel: DraftChannel,
  media: MediaFacts[],
  placement?: 'story'
): string[] {
  const story = DESTINATION_MEDIA[channel].story
  if (placement === 'story' && !story) return [`${LABELS[channel]} takes no stories.`]
  const rules = (placement === 'story' && story) || DESTINATION_MEDIA[channel]
  const label = placement === 'story' ? storyLabel(channel) : LABELS[channel]
  if (media.length === 0)
    return rules.requiresMedia
      ? [
          rules.images.length === 0
            ? `${label} needs one video. Add one to the post.`
            : rules.video
              ? `${label} needs at least one image or video. Add one to the post.`
              : `${label} needs an image. Add one to the post.`,
        ]
      : []
  if (media.length > rules.maxMedia)
    return [
      `${label} takes up to ${rules.maxMedia} attachment${rules.maxMedia === 1 ? '' : 's'} in one post; this one has ${media.length}. Remove some, or schedule them as separate posts.`,
    ]
  let images = 0,
    gifs = 0,
    videos = 0
  for (const [index, item] of media.entries()) {
    const name = `attachment ${index + 1}`
    const known = !item.mimeType.endsWith('/*')
    if (item.mimeType === 'image/gif') {
      if (!rules.gif)
        return [
          `${label} can't show a GIF's animation. Upload ${name} as an MP4 video, or remove it from the ${label} post.`,
        ]
      if (item.bytes !== undefined && item.bytes > rules.gif.maxBytes)
        return [
          `${label} takes GIFs up to ${Math.floor(rules.gif.maxBytes / 1_000_000)} MB; ${name} is ${(item.bytes / 1_000_000).toFixed(1)} MB.`,
        ]
      gifs++
    } else if (item.mimeType.startsWith('image/')) {
      if (rules.images.length === 0) return [`${label} requires one MP4 video; remove the image.`]
      if (known && !rules.images.includes(item.mimeType))
        return [
          `${label} takes ${formatNames(rules.images)} images; ${name} is ${formatNames([item.mimeType])}.`,
        ]
      if (rules.imageMaxBytes && item.bytes !== undefined && item.bytes > rules.imageMaxBytes)
        return [
          `${label} takes images up to ${rules.imageMaxBytes / 2 ** 20} MB; ${name} is ${(item.bytes / 2 ** 20).toFixed(1)} MB.`,
        ]
      if (item.width && item.height) {
        if (rules.minImageWidth && item.width < rules.minImageWidth)
          return [
            `${label} needs images at least ${rules.minImageWidth} pixels wide; ${name} is ${item.width}.`,
          ]
        const ratio = item.width / item.height
        if (rules.aspect && (ratio < rules.aspect.min - 0.005 || ratio > rules.aspect.max + 0.005))
          return [
            `${label} takes images from 4:5 portrait to 1.91:1 landscape; ${name} is ${item.width}×${item.height}. Crop it before scheduling.`,
          ]
      }
      images++
    } else if (item.mimeType.startsWith('video/')) {
      const video = rules.video
      if (!video) return [`${label} doesn't take video here.`]
      if (known && !video.formats.includes(item.mimeType))
        return [
          `${label} takes ${formatNames(video.formats)} video; ${name} is ${formatNames([item.mimeType])}. Export it as MP4.`,
        ]
      if (item.bytes !== undefined && item.bytes > video.maxBytes)
        return [
          `${label} takes videos up to ${Math.floor(video.maxBytes / 1_000_000)} MB; ${name} is ${Math.floor(item.bytes / 1_000_000)} MB.`,
        ]
      const { minMs = 0, maxMs = 0 } = video
      if ((minMs > 0 || maxMs > 0) && item.durationMs) {
        if (item.durationMs < minMs || (maxMs > 0 && item.durationMs > maxMs)) {
          const span =
            maxMs === 0
              ? `at least ${clock(minMs)} long`
              : minMs === 0
                ? `up to ${clock(maxMs)} long`
                : `from ${clock(minMs)} to ${clock(maxMs)} long`
          return [
            `${label} takes videos ${span}; ${name} is ${clock(item.durationMs)}. Trim it, or choose another destination.`,
          ]
        }
      }
      videos++
    } else if (item.mimeType === 'application/pdf') {
      return [
        'A PDF goes to LinkedIn as a document. Use the document option instead of attaching it.',
      ]
    } else {
      return [`${label} can't publish ${item.mimeType} files.`]
    }
  }
  if (media.length > 1 && ((gifs > 0 && rules.gif?.alone) || (videos > 0 && rules.video?.alone)))
    return [
      `${label} posts a video or GIF on its own. Move the other attachments to a separate post.`,
    ]
  if (!rules.mixed && videos > 0 && images + gifs > 0)
    return [`${label} can't mix images and video in one post.`]
  return []
}

/**
 * What Shots changes before a channel takes the media, so the person sees it
 * before scheduling: a format conversion, and lost transparency for JPEG.
 */
export function mediaChanges(channel: DraftChannel, media: MediaFacts[]): string[] {
  const converts = DESTINATION_MEDIA[channel].converts ?? {}
  const changes = new Set<string>()
  for (const item of media) {
    const target = converts[item.mimeType]
    if (!target) continue
    changes.add(
      target === 'image/jpeg'
        ? `${LABELS[channel]} takes JPEG only: Shots sends ${formatNames([item.mimeType])} images as JPEG, and transparent areas become white.`
        : `${LABELS[channel]} gets a ${formatNames([target])} copy of ${formatNames([item.mimeType])} images, with the same pixels.`
    )
  }
  return [...changes]
}
