import {
  CAPTION_CHANNELS,
  type CaptionChannel,
  captionChannelSchema,
  captionLength,
  type DesignCopy,
} from '@/lib/captions/channels'
import { draftAssetNode } from '@/lib/platform/asset-handoff'
import { CAPABILITIES } from '@/lib/write/capabilities'
import { type DraftChannel, draftChannelSchema, type PlateBody } from '@/lib/write/document'
import { type MediaFacts, mediaProblems } from '@/lib/write/media-rules'
import { postBreak } from '@/lib/write/versions'

/**
 * Publishing an editor design, as data.
 *
 * The editor writes alt text and a caption per platform (`DesignCopy`, from
 * the Captions panel) and exports images; Publish owns drafts, platform
 * versions and connected accounts. This module is the seam: it decides which
 * platforms a design can be posted to, and turns one export plus its copy
 * into the fields `POST /api/v1/content-drafts` already takes. Nothing here
 * touches the network or React, so the Publish panel, the Variants panel and
 * batch export all produce identical drafts.
 */

/**
 * Platforms the editor writes captions for that Publish can also post to.
 * Derived from both enums rather than listed again, so adding a platform to
 * either one cannot leave this behind. Facebook has captions but no
 * publishing adapter; TikTok and YouTube publish but have no written caption.
 */
export const PUBLISH_CHANNELS: readonly DraftChannel[] = captionChannelSchema.options.filter(
  (channel): channel is CaptionChannel & DraftChannel =>
    draftChannelSchema.safeParse(channel).success
)

/** Whether a caption channel is one the platform publishes to. */
export function isPublishChannel(channel: string): channel is DraftChannel & CaptionChannel {
  return (PUBLISH_CHANNELS as readonly string[]).includes(channel)
}

/**
 * The caption written for a publishing channel, trimmed, or empty. A channel
 * the editor writes no captions for (TikTok, YouTube) never has one.
 */
export function captionFor(copy: DesignCopy | null, channel: DraftChannel): string {
  return isPublishChannel(channel) ? (copy?.captions[channel]?.trim() ?? '') : ''
}

/** A connected account a design can be posted from. */
export type PublishAccount = {
  /** The channel connection id a draft references. */
  id: string
  channel: DraftChannel
  /** The handle or display name, for the account list. */
  name: string
}

/**
 * The accounts of `accounts` on `channels`, in the order the channels were
 * given. A channel with no connected account contributes nothing: a draft
 * never references an account the workspace does not have.
 */
export function accountsOn(
  accounts: readonly PublishAccount[],
  channels: readonly DraftChannel[]
): PublishAccount[] {
  return channels.flatMap((channel) => accounts.filter((account) => account.channel === channel))
}

/**
 * The channel whose caption becomes the draft's body. The others keep their
 * own text, so the body is always a caption someone wrote for a real
 * platform. Prefers a chosen channel that has a caption.
 */
export function primaryFor(
  channels: readonly DraftChannel[],
  copy: DesignCopy | null
): DraftChannel {
  return channels.find((channel) => captionFor(copy, channel)) ?? channels[0] ?? 'x'
}

/**
 * The body of the draft this design opens as: the primary channel's caption,
 * then the exported images with the design's alt text. Media on the first
 * post is what the composer copies into every other platform's version
 * (`readVersions`).
 *
 * The alt text is on the node as well as on the asset: the asset keeps it
 * for every future post, and the node is what the serializer sends to the
 * provider with this one.
 */
export function designPostBody(input: {
  altText?: string
  assets: readonly { id: string; mediaType: string }[]
  caption: string
}): PlateBody {
  return [
    postBreak(),
    { children: [{ text: input.caption }], type: 'p' },
    ...input.assets.map((asset) => ({ ...draftAssetNode(asset), alt: input.altText ?? '' })),
  ] as PlateBody
}

/**
 * The per-channel text a new draft carries: every chosen channel's caption
 * except the primary's, which is the body. The composer turns these into
 * manual platform versions, with the body's media, the first time the draft
 * is opened, so each platform posts the caption written for it.
 */
export function captionChannelText(
  copy: DesignCopy | null,
  channels: readonly DraftChannel[],
  primary: DraftChannel
): Partial<Record<DraftChannel, string>> {
  const text: Partial<Record<DraftChannel, string>> = {}
  for (const channel of channels) {
    if (channel === primary) continue
    const caption = captionFor(copy, channel)
    if (caption) text[channel] = caption
  }
  return text
}

/** A platform whose text does not fit there, and whether it is the body it reuses. */
export type CaptionOverLimit = {
  channel: DraftChannel
  length: number
  limit: number
  /** True when the platform has no caption of its own and posts the body. */
  reused: boolean
}

/**
 * Platforms whose text is over their limit, as each one counts it. A
 * platform with no caption of its own posts the body, so a long caption
 * written for LinkedIn is measured against Bluesky's 300 characters too:
 * the composer refuses to schedule either, and the editor says so before
 * the draft is made rather than after.
 */
export function captionsOverLimit(
  copy: DesignCopy | null,
  channels: readonly DraftChannel[],
  primary: DraftChannel
): CaptionOverLimit[] {
  const body = captionFor(copy, primary)
  return channels.flatMap((channel) => {
    if (!isPublishChannel(channel)) return []
    const own = captionFor(copy, channel)
    const caption = own || body
    if (!caption) return []
    const length = captionLength(caption, channel)
    const limit = CAPTION_CHANNELS[channel].limit
    return length > limit ? [{ channel, length, limit, reused: !own }] : []
  })
}

/**
 * What stops the exported image from being posted on each chosen platform,
 * from the media rules Go schedules with, said once per distinct problem.
 * The editor can say "Instagram does not take this aspect ratio" before the
 * draft is made, instead of the composer refusing to schedule it later.
 */
export function designMediaProblems(
  channels: readonly DraftChannel[],
  image: MediaFacts
): string[] {
  return [...new Set(channels.flatMap((channel) => mediaProblems(channel, [image])))]
}

/** A platform's name as both Publish and the captions panel write it. */
export function channelLabel(channel: DraftChannel): string {
  return CAPABILITIES[channel].label
}
