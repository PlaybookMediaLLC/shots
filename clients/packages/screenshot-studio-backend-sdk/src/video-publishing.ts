import { z } from 'zod'

/** Explicit YouTube metadata; incomplete choices may be saved in drafts. */
export const youtubeOptionsSchema = z.strictObject({
  title: z
    .string()
    .max(100)
    .refine((value) => !/[<>]/.test(value)),
  privacy: z.enum(['', 'public', 'private', 'unlisted']),
  madeForKids: z.boolean().optional(),
})

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
