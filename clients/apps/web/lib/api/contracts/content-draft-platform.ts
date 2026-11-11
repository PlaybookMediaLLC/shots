import { z } from 'zod'
import { workspaceDocs } from '@/lib/api/contracts/workspace-docs'
import { defineContract, timestampSchema } from '@/lib/api/contract'
import {
  contentDraftIdSchema,
  contentDraftParamsSchema,
  contentDraftPostSchema,
  contentDraftSchema,
  plateValueSchema,
} from '@/lib/api/contracts/content-drafts'
import { articleSchema, platformVersionsSchema } from '@/lib/write/document'

/**
 * Content drafts, round two (RFC 013): the posting queue and its settings,
 * best times, the calendar, moving and resuming posts, review, guest share
 * links, revisions, live posts' engagement, AI help and link cards.
 */

/** A weekly posting slot: a weekday (0 is Sunday) and a time as HH:MM. */
export const queueSlotSchema = z.object({
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  weekday: z.number().int().min(0).max(6),
})

/** A workspace's drafts settings. */
export const contentDraftSettingsSchema = z.object({
  postingSlots: z.array(queueSlotSchema),
  requireApproval: z.boolean(),
  /** When false, the person who last edited a draft cannot approve it. An older backend omits it. */
  allowSelfApproval: z.boolean().default(true),
  timeZone: z.string(),
})

/** `GET /api/v1/content-draft-settings` */
export const getContentDraftSettingsContract = defineContract({
  method: 'GET',
  name: 'content-drafts.settings',
  output: contentDraftSettingsSchema,
  path: '/api/v1/content-draft-settings',
  summary: "Read the workspace's drafts settings",
})

/** `PUT /api/v1/content-draft-settings` */
export const updateContentDraftSettingsContract = defineContract({
  body: z.object({
    postingSlots: z.array(queueSlotSchema).max(50).optional(),
    requireApproval: z.boolean().optional(),
    allowSelfApproval: z.boolean().optional(),
  }),
  method: 'PUT',
  name: 'content-drafts.settings-update',
  output: contentDraftSettingsSchema,
  path: '/api/v1/content-draft-settings',
  summary: "Save the workspace's drafts settings",
})

/** `GET /api/v1/content-draft-queue/best-times` */
export const bestPostingTimesContract = defineContract({
  access: { apiKeyScope: 'artifact:read', feature: 'content:drafts', permission: 'artifact:read' },
  docs: workspaceDocs({
    operationId: 'bestPostingTimes',
    description:
      "Suggests times from this social set's stored engagement, or explicitly labelled default times when there is insufficient history.",
    extensions: { 'x-shots-entitlement': { feature: 'content:drafts' } },
    responses: { '200': 'The authorized result.', '404': 'The social set is unavailable.' },
    tag: 'Workspace',
  }),
  method: 'GET',
  name: 'content-drafts.best-times',
  output: z.object({
    items: z.array(
      z.object({
        at: timestampSchema,
        reason: z.string(),
        score: z.number().nonnegative().optional(),
        samplePosts: z.number().int().nonnegative().default(0),
      })
    ),
  }),
  path: '/api/v1/content-draft-queue/best-times',
  /** One social set's times and engagement; the workspace's default set when omitted. */
  query: z.object({ socialSetId: contentDraftIdSchema.optional() }),
  summary: 'Suggest the next times to post',
})

/** A draft post on the calendar or in the queue. */
export const calendarPostSchema = contentDraftPostSchema.extend({
  campaignId: z.string().nullish(),
  campaignTitle: z.string().optional(),
  version: z.number().int().nonnegative(),
  calendarVersion: z.number().int().nonnegative(),
  draftId: z.string(),
  draftTitle: z.string(),
  socialSetId: z.string().nullable(),
  tagIds: z.array(z.string()),
})

/** `GET /api/v1/content-draft-posts?from&to` */
export const listCalendarPostsContract = defineContract({
  access: { apiKeyScope: 'artifact:read', feature: 'content:drafts', permission: 'artifact:read' },
  docs: workspaceDocs({
    operationId: 'listCalendarPosts',
    description:
      'Lists visible draft deliveries in a window of at most 100 days (maximum 500 rows). Includes scheduled, publishing, published, failed and unknown outcomes; private sets remain hidden from API keys.',
    extensions: { 'x-shots-entitlement': { feature: 'content:drafts' } },
    responses: { '200': 'The authorized result.', '404': 'The social set is unavailable.' },
    tag: 'Workspace',
  }),
  method: 'GET',
  name: 'content-drafts.calendar',
  output: z.object({ items: z.array(calendarPostSchema) }),
  path: '/api/v1/content-draft-posts',
  /** One social set's posts; every set you can see when `socialSetId` is omitted. */
  query: z.object({
    from: z.coerce.date(),
    socialSetId: contentDraftIdSchema.optional(),
    to: z.coerce.date(),
  }),
  summary: 'List draft posts due between two times',
})

/** Path parameters naming one draft post. */
export const draftPostParamsSchema = z.object({ id: contentDraftIdSchema })

/** Consume a queued snapshot once and dispatch it immediately. */
export const publishQueuedDraftPostContract = defineContract({
  method: 'POST',
  name: 'content-drafts.post-publish-now',
  output: z.object({ post: contentDraftPostSchema }),
  params: draftPostParamsSchema,
  path: '/api/v1/content-draft-posts/{id}/publish-now',
  summary: 'Publish a queued post now',
})

/** Atomically swap two queued commitments on the same account. */
export const swapDraftPostsContract = defineContract({
  body: z.object({ withId: contentDraftIdSchema }),
  method: 'POST',
  name: 'content-drafts.post-swap',
  output: z.object({ posts: z.array(contentDraftPostSchema) }),
  params: draftPostParamsSchema,
  path: '/api/v1/content-draft-posts/{id}/swap',
  summary: 'Swap the times of two queued posts on the same account',
})

/** `POST /api/v1/content-draft-posts/{id}/move` */
export const moveDraftPostContract = defineContract({
  body: z.object({
    scheduledFor: z.coerce
      .date()
      .refine((value) => value.getTime() > Date.now(), { message: 'Pick a time in the future.' }),
  }),
  method: 'POST',
  name: 'content-drafts.post-move',
  output: z.object({ post: contentDraftPostSchema }),
  params: draftPostParamsSchema,
  path: '/api/v1/content-draft-posts/{id}/move',
  summary: 'Move a queued draft post to a new time',
})

/** `POST /api/v1/content-draft-posts/{id}/resume` */
export const resumeDraftThreadContract = defineContract({
  method: 'POST',
  name: 'content-drafts.thread-resume',
  output: z.object({ post: contentDraftPostSchema }),
  params: draftPostParamsSchema,
  path: '/api/v1/content-draft-posts/{id}/resume',
  status: 201,
  summary: 'Post the rest of a thread that stopped partway',
})

/** `POST /api/v1/content-draft-posts/{id}/metrics` */
export const refreshDraftPostMetricsContract = defineContract({
  method: 'POST',
  name: 'content-drafts.post-metrics',
  output: z.object({ post: contentDraftPostSchema }),
  params: draftPostParamsSchema,
  path: '/api/v1/content-draft-posts/{id}/metrics',
  summary: "Read a live post's engagement now",
})

/** `POST /api/v1/content-drafts/{id}/review` */
export const reviewContentDraftContract = defineContract({
  body: z.object({
    action: z.enum(['request', 'approve', 'changes']),
    version: z.number().int().min(1),
    note: z.string().max(2_000).optional(),
  }),
  method: 'POST',
  name: 'content-drafts.review',
  output: contentDraftSchema,
  params: contentDraftParamsSchema,
  path: '/api/v1/content-drafts/{id}/review',
  summary: 'Ask for review, approve, or ask for changes',
})

/** `PUT /api/v1/content-drafts/{id}/share` */
export const shareContentDraftContract = defineContract({
  body: z.object({ enabled: z.boolean() }),
  method: 'PUT',
  name: 'content-drafts.share',
  output: contentDraftSchema,
  params: contentDraftParamsSchema,
  path: '/api/v1/content-drafts/{id}/share',
  summary: "Turn a draft's read-and-comment link on or off",
})

/** Why a backup was kept. */
export const revisionReasonSchema = z.enum([
  'edit',
  'schedule',
  'plan',
  'publish',
  'recovery',
  'calendar.move',
  'calendar.swap',
  'calendar.unschedule',
  'calendar.remove_date',
])

/** A saved point in a draft's history: an immutable automatic backup. */
export const contentDraftRevisionSchema = z.object({
  /** An article's title and cover as they were (one revision's read). */
  article: articleSchema.optional(),
  body: plateValueSchema.optional(),
  createdAt: timestampSchema,
  createdByUserId: z.string().nullable(),
  id: z.string(),
  plainText: z.string(),
  /** The platform versions as they were (one revision's read). */
  platformVersions: platformVersionsSchema.optional(),
  reason: revisionReasonSchema,
  title: z.string(),
  version: z.number().int(),
})

/** `GET /api/v1/content-drafts/{id}/revisions` */
export const listContentDraftRevisionsContract = defineContract({
  method: 'GET',
  name: 'content-drafts.revisions',
  output: z.object({ items: z.array(contentDraftRevisionSchema) }),
  params: contentDraftParamsSchema,
  path: '/api/v1/content-drafts/{id}/revisions',
  summary: "List a draft's revisions, newest first",
})

/** `GET /api/v1/content-drafts/{id}/revisions/{revisionId}` */
export const getContentDraftRevisionContract = defineContract({
  method: 'GET',
  name: 'content-drafts.revision',
  output: contentDraftRevisionSchema,
  params: contentDraftParamsSchema.extend({ revisionId: contentDraftIdSchema }),
  path: '/api/v1/content-drafts/{id}/revisions/{revisionId}',
  summary: 'Read one revision of a draft, with its body',
})

/** A link's card: what a channel shows for it. */
export const linkCardSchema = z.object({
  description: z.string().nullable(),
  image: z.string().nullable(),
  siteName: z.string().nullable(),
  title: z.string().nullable(),
  url: z.string(),
})

/** `GET /api/v1/content-drafts/link-card?url` */
export const draftLinkCardContract = defineContract({
  method: 'GET',
  name: 'content-drafts.link-card',
  output: linkCardSchema,
  path: '/api/v1/content-drafts/link-card',
  query: z.object({ url: z.string().url().max(2_000) }),
  summary: 'Read the card a channel shows for a link',
})

/** A guest's view of a shared draft. */
export const sharedContentDraftSchema = z.object({
  imageAssetId: z.string().nullable().optional(),
  published: z.boolean().optional(),
  publishedUrl: z.string().url().nullable().optional(),
  body: plateValueSchema,
  guestComments: z.array(
    z.object({ createdAt: timestampSchema, name: z.string(), text: z.string() })
  ),
  plainText: z.string(),
  title: z.string(),
  updatedAt: timestampSchema,
})

/** `POST /api/drafts/shared/{token}/comments` */
export const addGuestCommentContract = defineContract({
  body: z.object({
    name: z.string().trim().min(1).max(80),
    text: z.string().trim().min(1).max(2_000),
  }),
  method: 'POST',
  name: 'content-drafts.guest-comment',
  output: sharedContentDraftSchema,
  params: z.object({ token: z.string().min(20).max(64) }),
  path: '/api/drafts/shared/{token}/comments',
  status: 201,
  summary: 'Leave a comment on a shared draft',
})

/** `POST /api/v1/content-draft-posts/swap`; session publishers only. */
export const swapDraftPostTimesContract = defineContract({
  method: 'POST',
  name: 'content-drafts.swap-post-times',
  path: '/api/v1/content-draft-posts/swap',
  body: z.strictObject({ first: z.string().min(1).max(128), second: z.string().min(1).max(128) }),
  output: z.object({ swapped: z.literal(true) }),
  summary: 'Exchange two future queue positions atomically',
})

/** GET /api/drafts/shared/{token}/image: revocable preview of the first shared image. */
export const sharedDraftImageContract = defineContract({
  method: 'GET',
  name: 'content-drafts.shared-image',
  path: '/api/drafts/shared/{token}/image',
  params: z.object({ token: z.string().min(20).max(64) }),
  output: z.unknown(),
  summary: 'Read a shared draft preview image',
})
