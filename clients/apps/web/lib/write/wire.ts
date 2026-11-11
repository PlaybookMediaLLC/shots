import { z } from 'zod'
import { timestampSchema } from '@/lib/api/contract'
import {
  articleSchema,
  draftKindSchema,
  draftTargetSchema,
  platformVersionsSchema,
} from '@/lib/write/document'

/**
 * What Write (RFC 025) adds to a content draft on the wire: the fields a
 * draft returns, the fields it is written with, and how lists are filtered.
 * The draft contracts extend their schemas with these shapes.
 */

/** The Write fields a draft returns. */
export const draftWriteFieldsSchema = z.object({
  /** An X article's title and cover, for an article draft. */
  article: articleSchema.nullable(),
  /** Posts that failed or whose outcome is unknown (lists only). */
  attentionPosts: z.number().int(),
  /** The attention posts whose outcome is unknown (lists only). */
  checkPosts: z.number().int().default(0),
  /** The queued posts that are publishing now (lists only). */
  publishingPosts: z.number().int().default(0),
  kind: draftKindSchema,
  /** When the next scheduled post goes out (lists only). */
  nextPostAt: timestampSchema.nullable(),
  pinnedAt: timestampSchema.nullable(),
  /** The zone a planned time was picked in. */
  planTimeZone: z.string().nullable(),
  /** Each platform's version beside the primary body. */
  platformVersions: platformVersionsSchema,
  /** Posts waiting to go out (lists only). */
  queuedPosts: z.number().int(),
  /** Internal notes; never part of a post. */
  scratchpad: z.string(),
  /** The draft it was duplicated, copied or recovered from. */
  sourceDraftId: z.string().nullable(),
  /** Tags of the draft's set, by id (an experiment). */
  tagIds: z.array(z.string()),
  /** The post a reply answers, a quote embeds, or a repurposed draft came from. */
  target: draftTargetSchema.nullable(),
})

/** One X follow-up a draft runs once its post reaches a number of likes (RFC 024). */
const draftEngagementRuleSchema = z.object({
  atLikes: z.number().int(),
  enabled: z.boolean(),
  text: z.string().optional(),
})

const NO_RULE = { atLikes: 0, enabled: false }

/**
 * The follow-ups a draft copied from its set's engagement defaults (RFC 024).
 * The default keeps an older backend's answer readable.
 */
export const draftEngagementSchema = z
  .object({ autoPlug: draftEngagementRuleSchema, autoRepost: draftEngagementRuleSchema })
  .default({ autoPlug: NO_RULE, autoRepost: NO_RULE })

/** The Write fields a draft is created or updated with. */
export const draftWriteInputSchema = z.object({
  /** An X article's title and cover, for an article draft. */
  article: articleSchema.optional(),
  /** Each platform's version beside the primary body. */
  platformVersions: platformVersionsSchema.optional(),
  /** The post a reply answers or a quote embeds. */
  target: draftTargetSchema.optional(),
})

/** How a draft list is ordered. */
export const contentDraftSortSchema = z.enum([
  'updated_desc',
  'updated_asc',
  'created_desc',
  'created_asc',
])

/** One of {@link contentDraftSortSchema}. */
export type ContentDraftSort = z.infer<typeof contentDraftSortSchema>

/** A lifecycle tab: not yet live, something went live, a post needs someone, or archived. */
export const contentDraftViewSchema = z.enum(['drafts', 'posted', 'failed', 'archived'])

/** One of {@link contentDraftViewSchema}. */
export type ContentDraftView = z.infer<typeof contentDraftViewSchema>

/**
 * When a schedule goes out, beside `scheduledFor`: now (`publishNow`), or a
 * local time in a zone that the backend resolves, refusing a skipped time
 * and asking which repeated time is meant.
 */
export const scheduleTimingSchema = z.object({
  disambiguation: z.enum(['earlier', 'later']).optional(),
  localTime: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    .optional(),
  publishNow: z.boolean().optional(),
  timeZone: z.string().max(80).optional(),
})

/** A follow-up's kind. */
export const postAutomationKindSchema = z.enum([
  'first_comment',
  'retweet',
  'unretweet',
  'plug',
  'repost_at_likes',
  'quote',
])

/** Where a follow-up is: waiting, settled one way or another. */
export const postAutomationStatusSchema = z.enum([
  'pending',
  'done',
  'failed',
  'skipped',
  'cancelled',
  'expired',
])

/**
 * A live post's follow-up and its receipt (RFC 025). `failureCode` is a
 * short code such as `http_403` or `threshold_not_reached`, never a
 * provider message.
 */
export const postAutomationSchema = z.object({
  attempts: z.number().int(),
  dueAt: timestampSchema,
  failureCode: z.string().nullable(),
  key: z.string(),
  kind: postAutomationKindSchema,
  remoteId: z.string().nullable(),
  status: postAutomationStatusSchema,
  updatedAt: timestampSchema,
})
