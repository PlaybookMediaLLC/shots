import { z } from 'zod'

const commentId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const baseVersion = z.number().int().min(1)
const content = {
  text: z.string().trim().min(1).max(5000),
  mentionUserIds: z.array(z.string().min(1).max(128)).max(20).optional(),
}

/** One comment action; it cannot carry document, author, or permission fields. */
export const draftCommentInputSchema = z.xor([
  z.strictObject({
    action: z.literal('add'),
    baseVersion,
    commentId,
    threadId: commentId.optional(),
    ...content,
  }),
  z.strictObject({
    action: z.literal('edit'),
    baseVersion,
    commentId,
    threadId: commentId,
    ...content,
  }),
  z.strictObject({ action: z.literal('delete'), baseVersion, commentId, threadId: commentId }),
  z.strictObject({
    action: z.literal('resolve'),
    baseVersion,
    threadId: commentId,
    resolved: z.boolean(),
  }),
  z.strictObject({ action: z.literal('delete_thread'), baseVersion, threadId: commentId }),
  // Anchored and unanchored adds are exclusive: preserve the original wire alternative.
  z.strictObject({
    action: z.literal('add'),
    baseVersion,
    commentId,
    threadId: commentId.optional(),
    anchor: z.strictObject({
      platform: z.enum([
        'x',
        'linkedin',
        'threads',
        'mastodon',
        'bluesky',
        'instagram',
        'tiktok',
        'youtube',
        'facebook',
        'pinterest',
        'gmb',
      ]),
      postId: commentId,
      quote: z.string().min(1).max(5000).optional(),
    }),
    ...content,
  }),
])

/** A validated member comment action. */
export type DraftCommentInput = z.infer<typeof draftCommentInputSchema>
