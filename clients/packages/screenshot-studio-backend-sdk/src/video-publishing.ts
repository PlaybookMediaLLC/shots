import { z } from 'zod'

/** Explicit YouTube metadata; incomplete choices may be saved in drafts. */
export const youtubeOptionsSchema = z.strictObject({
  title: z
    .string()
    .max(100)
    .refine((value) => !/[<>]/.test(value)),
  privacy: z.enum(['', 'public', 'private', 'unlisted']),
  madeForKids: z.boolean().optional(),
  /** snippet.tags; Go checks them when the post is scheduled, so a draft always saves. */
  tags: z.array(z.string()).optional(),
  /** status.containsSyntheticMedia: realistic altered or synthetic content. */
  containsSyntheticMedia: z.boolean().optional(),
  /** Set as the custom thumbnail once the video is live, as its own follow-up. */
  thumbnailAssetId: z.string().min(1).max(64).optional(),
})

/** An Instagram username without its @: up to 30 letters, digits, dots and underscores, no dot first, last or twice in a row. */
export const instagramUsernameSchema = z
  .string()
  .max(30)
  .regex(/^[A-Za-z0-9_](?:[A-Za-z0-9_]|\.[A-Za-z0-9_])*$/)

/** Instagram settings beyond the caption, sent as media container parameters. */
export const instagramOptionsSchema = z.strictObject({
  collaborators: z.array(instagramUsernameSchema).max(3).optional(),
  userTags: z.array(instagramUsernameSchema).max(20).optional(),
  /** A reel's cover image. */
  coverAssetId: z.string().min(1).max(64).optional(),
  /** False keeps a reel off the profile grid; unset is Instagram's default. */
  shareToFeed: z.boolean().optional(),
  trialReel: z.boolean().optional(),
  trialGraduation: z.enum(['MANUAL', 'SS_PERFORMANCE']).optional(),
  /** "story": one image or video as a story, with no caption and none of the above. */
  placement: z.enum(['story']).optional(),
})

/** Instagram metadata stored with a scheduled snapshot. */
export type InstagramOptions = z.infer<typeof instagramOptionsSchema>

/**
 * A pin's board, title and link. The board is one of the account's, by its
 * numeric id; Go requires it when the pin is scheduled, so a draft always saves.
 */
export const pinterestOptionsSchema = z.strictObject({
  boardId: z
    .string()
    .regex(/^[0-9]{1,30}$/)
    .optional(),
  /** Up to 100 characters, counted as Go counts them (code points). */
  title: z
    .string()
    .refine((value) => [...value].length <= 100)
    .optional(),
  link: z.string().max(2048).optional(),
})

/** Pinterest metadata stored with a scheduled snapshot. */
export type PinterestOptions = z.infer<typeof pinterestOptionsSchema>

/** TikTok settings selected by the creator for direct publishing. */
export const tiktokOptionsSchema = z.strictObject({
  privacy: z.enum([
    '',
    'PUBLIC_TO_EVERYONE',
    'MUTUAL_FOLLOW_FRIENDS',
    'FOLLOWER_OF_CREATOR',
    'SELF_ONLY',
  ]),
  allowComments: z.boolean(),
  allowDuet: z.boolean(),
  allowStitch: z.boolean(),
  commercialContent: z.boolean().optional(),
  brandOrganic: z.boolean(),
  brandedContent: z.boolean(),
  madeWithAi: z.boolean(),
  consent: z.boolean(),
})

/** YouTube metadata stored with a scheduled snapshot. */
export type YouTubeOptions = z.infer<typeof youtubeOptionsSchema>
/** TikTok metadata stored with a scheduled snapshot. */
export type TikTokOptions = z.infer<typeof tiktokOptionsSchema>

/** Current TikTok controls fetched from the selected account. */
export const tiktokCreatorSchema = z.strictObject({
  nickname: z.string().min(1),
  privacyLevels: z.array(tiktokOptionsSchema.shape.privacy.exclude([''])).min(1),
  maxDurationSeconds: z.number().int().positive(),
  commentDisabled: z.boolean(),
  duetDisabled: z.boolean(),
  stitchDisabled: z.boolean(),
})

/** A confirmed remote identity, retained even while processing is unresolved. */
export const publicationReceiptSchema = z.object({
  remoteId: z.string(),
  url: z.string().url(),
  visibility: z.string().optional(),
})

export type PublicationReceipt = z.infer<typeof publicationReceiptSchema>
