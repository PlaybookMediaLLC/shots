import { z } from 'zod'
import { youtubeOptionsSchema, tiktokOptionsSchema } from 'screenshot-studio-backend-sdk'

/**
 * The Write document (RFC 025): the structured parts of a content draft
 * beside its Plate body. Go stores and checks the same shapes
 * (`server/internal/draftdoc`); every field here has a Go counterpart.
 */

/** Channels a draft can be written for and scheduled to. */
export const draftChannelSchema = z.enum([
  'x',
  'linkedin',
  'instagram',
  'threads',
  'bluesky',
  'mastodon',
  'tiktok',
  'youtube',
])

/** One of {@link draftChannelSchema}. */
export type DraftChannel = z.infer<typeof draftChannelSchema>

/** The channel a draft's body is written for: its primary platform (RFC 024), X when unset. */
export function primaryChannel(primaryPlatform: string | null | undefined): DraftChannel {
  return draftChannelSchema.catch('x').parse(primaryPlatform ?? 'x')
}

/** What kind of post a draft is. A thread is a standard draft with several posts. */
export const draftKindSchema = z.enum(['standard', 'reply', 'quote', 'repurpose', 'article'])

/** One of {@link draftKindSchema}. */
export type DraftKind = z.infer<typeof draftKindSchema>

/**
 * How a platform version gets its text: `synced` from the primary body each
 * time it is serialized, or `manual` from its own body.
 */
export const platformVersionModeSchema = z.enum(['synced', 'manual'])

/** One of {@link platformVersionModeSchema}. */
export type PlatformVersionMode = z.infer<typeof platformVersionModeSchema>

/** Numbering formats: #1, 1️⃣, 1., 1/, /1, 1/9 and 1 of 9. */
export const numberingStyleSchema = z.enum([
  'hash',
  'emoji',
  'dot',
  'slash',
  'leading',
  'fraction',
  'of',
])

/** One of {@link numberingStyleSchema}. */
export type NumberingStyle = z.infer<typeof numberingStyleSchema>

/** Where the number goes: before or after a post's text. */
export const numberingPositionSchema = z.enum(['start', 'end'])

/** One of {@link numberingPositionSchema}. */
export type NumberingPosition = z.infer<typeof numberingPositionSchema>

/** A thread's numbering, applied when it is serialized; the text never holds it. */
export const numberingSchema = z.strictObject({
  enabled: z.boolean(),
  position: numberingPositionSchema,
  skipFirst: z.number().int().min(0).max(24).optional(),
  skipLast: z.number().int().min(0).max(24).optional(),
  style: numberingStyleSchema,
})

/** One of {@link numberingSchema}. */
export type Numbering = z.infer<typeof numberingSchema>

/** An X community to post to, and whether followers see the post too. */
export const communitySchema = z.strictObject({
  id: z.string().regex(/^\d{1,30}$/),
  name: z.string().max(200).optional(),
  shareWithFollowers: z.boolean().optional(),
})

/** A persisted Open Graph card and an explicit removal choice. */
export const linkPreviewSchema = z.strictObject({
  url: z.url().max(2048),
  title: z.string().max(250).optional(),
  description: z.string().max(1000).optional(),
  image: z.url().max(2048).optional(),
  removed: z.boolean().optional(),
})

/** One stored card, scoped to a platform version. */
export type LinkPreview = z.infer<typeof linkPreviewSchema>

/** One of {@link communitySchema}. */
export type Community = z.infer<typeof communitySchema>

/** Who sees a LinkedIn post. */
export const linkedInVisibilitySchema = z.enum(['PUBLIC', 'CONNECTIONS'])

/** One of {@link linkedInVisibilitySchema}. */
export type LinkedInVisibility = z.infer<typeof linkedInVisibilitySchema>

/** A workspace id: a cuid or a UUID. */
export const writeIdSchema = z
  .string()
  .regex(/^(?:[a-z0-9]{10,32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/)

/** A PDF workspace asset posted as a LinkedIn document carousel. */
export const documentAttachmentSchema = z.strictObject({
  assetId: writeIdSchema,
  title: z.string().max(200).optional(),
})

/** One of {@link documentAttachmentSchema}. */
export type DocumentAttachment = z.infer<typeof documentAttachmentSchema>

/** A wall-clock time of day, "HH:MM". */
export const clockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

/**
 * When to repost (Auto-RT): `afterMinutes` after publishing, or `days`
 * after the day it was published at `at` in `timeZone`. The forms stay
 * apart: a time of day holds across a daylight-saving change, a duration
 * does not.
 */
export const retweetRuleSchema = z.union([
  z.strictObject({ afterMinutes: z.number().int().min(1).max(43_200) }),
  z.strictObject({
    at: clockTimeSchema,
    days: z.number().int().min(0).max(30),
    timeZone: z.string().min(1).max(64),
  }),
])

/** One of {@link retweetRuleSchema}. */
export type RetweetRule = z.infer<typeof retweetRuleSchema>

/** What an auto plug waits for. */
export const plugMetricSchema = z.enum(['likes', 'reposts'])

/** One of {@link plugMetricSchema}. */
export type PlugMetric = z.infer<typeof plugMetricSchema>

/**
 * An X post's follow-ups once live (RFC 025): reposts at set times and
 * their removal, a plug reply at a like or repost count, and the RFC 013
 * like-gated repost and delayed quote.
 */
export const automationSchema = z.strictObject({
  plugAtLikes: z.number().int().min(0).max(1_000_000).optional(),
  plugMetric: plugMetricSchema.optional(),
  plugText: z.string().max(1_000).optional(),
  quoteAfterHours: z.number().int().min(0).max(720).optional(),
  quoteText: z.string().max(1_000).optional(),
  repostAtLikes: z.number().int().min(0).max(1_000_000).optional(),
  retweets: z.array(retweetRuleSchema).max(5).optional(),
  unretweetAfterMinutes: z.number().int().min(0).max(10_080).optional(),
})

/** One of {@link automationSchema}. */
export type Automation = z.infer<typeof automationSchema>

/** The variables an Auto-DM message may use; Go's `autodm.Config.Validate` allows the same. */
export const AUTO_DM_VARIABLES = ['first_name', 'full_name', 'username', 'action', 'post_url']

/** Prepared Auto-DM settings. Delivery is disabled until authorized provider access is configured. */
export const autoDmSchema = z
  .strictObject({
    match: z.enum(['any', 'all']),
    reposts: z.boolean(),
    replies: z.boolean(),
    requireFollow: z.boolean(),
    replyText: z.string().max(100).optional(),
    message: z
      .string()
      .max(10_000)
      .refine((message) => message.trim() !== '', 'Write the message.')
      .refine(
        (message) =>
          [...message.matchAll(/\{\{([^{}]+)\}\}/g)].every(([, name]) =>
            AUTO_DM_VARIABLES.includes(name)
          ),
        'Use only the listed variables.'
      ),
  })
  .refine((value) => value.replies || value.reposts, 'Choose replies or reposts.')
  .refine((value) => !value.replyText || value.replies, 'A reply filter needs replies.')
/** One prepared campaign configuration. */
export type AutoDm = z.infer<typeof autoDmSchema>

/** A platform version's settings; each belongs to the platforms that support it. */
export const versionOptionsSchema = z.strictObject({
  youtube: youtubeOptionsSchema.optional(),
  tiktok: tiktokOptionsSchema.optional(),
  autoDm: autoDmSchema.optional(),
  splitOnPaste: z.boolean().optional(),
  linkPreviews: z.array(linkPreviewSchema).max(25).optional(),
  splitLimit: z.number().int().min(25).max(25_000).optional(),
  automation: automationSchema.optional(),
  community: communitySchema.optional(),
  document: documentAttachmentSchema.optional(),
  firstComment: z.string().max(1_250).optional(),
  numbering: numberingSchema.optional(),
  visibility: linkedInVisibilitySchema.optional(),
})

/** One of {@link versionOptionsSchema}. */
export type VersionOptions = z.infer<typeof versionOptionsSchema>

/** Plate JSON: a list of block nodes. */
export const plateBodySchema = z.array(z.record(z.string(), z.unknown())).max(5_000)

/** One of {@link plateBodySchema}. */
export type PlateBody = z.infer<typeof plateBodySchema>

/** One channel's version of a draft. */
export const platformVersionSchema = z.strictObject({
  body: plateBodySchema.optional(),
  channel: draftChannelSchema,
  /** The draft version the manual body was copied at. */
  forkedFromVersion: z.number().int().min(0).optional(),
  mode: platformVersionModeSchema,
  options: versionOptionsSchema.optional(),
  /** Identifies the primary's text when the manual body was copied. */
  sourceHash: z.string().max(128).optional(),
})

/** One of {@link platformVersionSchema}. */
export type PlatformVersion = z.infer<typeof platformVersionSchema>

/** The schema version of the platform versions document this app writes. */
export const PLATFORM_VERSIONS_SCHEMA = 1

/** Every platform version of a draft beside its primary body. */
export const platformVersionsSchema = z.strictObject({
  schemaVersion: z.literal(PLATFORM_VERSIONS_SCHEMA),
  versions: z.array(platformVersionSchema).max(draftChannelSchema.options.length),
})

/** One of {@link platformVersionsSchema}. */
export type PlatformVersions = z.infer<typeof platformVersionsSchema>

/** An empty platform versions document: every version synced, no options. */
export const EMPTY_PLATFORM_VERSIONS: PlatformVersions = {
  schemaVersion: PLATFORM_VERSIONS_SCHEMA,
  versions: [],
}

/** What a target is: the post a reply answers, a quote embeds, or a repost came from. */
export const draftTargetKindSchema = z.enum(['reply', 'quote', 'repurpose'])

/** One of {@link draftTargetKindSchema}. */
export type DraftTargetKind = z.infer<typeof draftTargetKindSchema>

/** The post a reply, quote or repurposed draft refers to, stored as data. */
export const draftTargetSchema = z.strictObject({
  author: z.string().max(200).optional(),
  kind: draftTargetKindSchema.optional(),
  platform: z.string().max(40).optional(),
  remoteId: z.string().max(200).optional(),
  sourceDraftId: writeIdSchema.optional(),
  sourcePostId: writeIdSchema.optional(),
  text: z.string().max(1_000).optional(),
  url: z.string().max(2_048).optional(),
})

/** One of {@link draftTargetSchema}. */
export type DraftTarget = z.infer<typeof draftTargetSchema>

/** An X article's title and cover; its body is the draft's body. */
export const articleSchema = z.strictObject({
  coverAssetId: writeIdSchema.optional(),
  title: z.string().max(200),
})

/** One of {@link articleSchema}. */
export type Article = z.infer<typeof articleSchema>

/** Who can reply to an X post. Replies never change who can see it. */
export const replySettingsSchema = z.enum([
  'everyone',
  'following',
  'mentionedUsers',
  'subscribers',
  'verified',
])

/** One of {@link replySettingsSchema}. */
export type ReplySettings = z.infer<typeof replySettingsSchema>

/** An X post's content labels. */
export const disclosuresSchema = z.strictObject({
  madeWithAi: z.boolean().optional(),
  paidPartnership: z.boolean().optional(),
})

/** One of {@link disclosuresSchema}. */
export type Disclosures = z.infer<typeof disclosuresSchema>

/**
 * A poll on a post. On X the post's text is the question; on LinkedIn the
 * question is its own field. Each platform's limits are checked separately
 * (`lib/write/capabilities.ts`).
 */
export const postPollSchema = z.strictObject({
  durationMinutes: z.number().int().min(0).max(527_040),
  multiple: z.boolean().optional(),
  options: z.array(z.string().max(1000)).min(2).max(20),
  // Draft storage permits incomplete questions; provider validation uses
  // Unicode characters and the 140-character LinkedIn limit before publishing.
  question: z.string().max(1000).optional(),
})

/** One of {@link postPollSchema}. */
export type PostPoll = z.infer<typeof postPollSchema>

/**
 * A post's settings, kept on the post break that starts it, so they move
 * with the post when it is reordered.
 */
export const postSettingsSchema = z.object({
  photoTagIds: z
    .array(z.string().regex(/^[0-9]{1,19}$/))
    .max(10)
    .optional(),
  disclosures: disclosuresSchema.optional(),
  /** A stable id: the post's identity across edits, moves and saves. */
  id: z.string().max(64).optional(),
  poll: postPollSchema.optional(),
  /** A finisher post that quotes the thread's first post once it is live. */
  quoteFirstPost: z.boolean().optional(),
  replySettings: replySettingsSchema.optional(),
})

/** One of {@link postSettingsSchema}. */
export type PostSettings = z.infer<typeof postSettingsSchema>
