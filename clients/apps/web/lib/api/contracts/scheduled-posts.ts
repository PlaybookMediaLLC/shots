import { z } from 'zod'
import { defineContract, mirrors, pageOf } from '@/lib/api/contract'
import { idempotencyKeySchema } from '@/lib/api/contracts/releases'
import { workspaceDocs } from '@/lib/api/contracts/workspace-docs'
import type { listBackendScheduledPosts } from '@/lib/tenant/publishing-backend'
import {
  hasOneScheduledPostSource,
  scheduledPostCreateSchema,
  scheduledPostListQuerySchema,
} from '@/lib/tenant/schemas'

/**
 * Scheduled post contracts (RFC 030, RFC 026). A member with
 * `publish:manage` reads the schedule, and changes it with a sign-in under 15
 * minutes old with two-factor. A key reads it with `artifact:read` and changes
 * it with `post:schedule`. Only approved variants can be scheduled.
 */

/** Delivery states of a scheduled post. */
export const scheduledPostStatusSchema = z.enum([
  'DRAFT',
  'SCHEDULED',
  'PROCESSING',
  'PUBLISHED',
  'FAILED',
  'CANCELLED',
  'UNKNOWN_DELIVERY',
  /** Sent to the network's app as a draft; the person finishes and posts it there. */
  'SENT_TO_APP',
])

/** A post scheduled to a channel connection. */
export const scheduledPostSchema = mirrors<
  Awaited<ReturnType<typeof listBackendScheduledPosts>>[number]
>()(
  z.object({
    caption: z.string(),
    channelConnection: z.object({
      externalAccountId: z.string(),
      platform: z.string(),
      provider: z.string(),
    }),
    channelConnectionId: z.string(),
    createdAt: z.string().describe('RFC 3339 timestamp.'),
    id: z.string(),
    scheduledFor: z.string().describe('RFC 3339 timestamp of the planned publication.'),
    status: scheduledPostStatusSchema,
    contentDraftId: z
      .string()
      .nullable()
      .describe('The content draft the post came from, when it has no variant.'),
    variantId: z
      .string()
      .nullable()
      .describe('The approved campaign variant the post came from, when it has no draft.'),
  })
)

/** A scheduled post as created or cancelled; the channel connection may be omitted. */
export const scheduledPostResultSchema = scheduledPostSchema.partial({ channelConnection: true })

/** `GET /api/v1/scheduled-posts` */
export const listScheduledPostsContract = defineContract({
  access: { apiKeyScope: 'artifact:read', permission: 'publish:manage' },
  docs: workspaceDocs({
    description:
      'Lists the workspace publishing schedule, newest first, up to `limit` posts. `pagination.hasMore` is true when the page is full. Requires the `artifact:read` scope, or a member who manages publishing.',
    operationId: 'listScheduledPosts',
    outputName: 'ScheduledPostListResponse',
    responses: { '200': 'Scheduled posts.', '400': 'The list query is invalid.' },
    tag: 'Publishing',
  }),
  method: 'GET',
  name: 'scheduled-posts.list',
  output: pageOf(scheduledPostSchema),
  path: '/api/v1/scheduled-posts',
  query: scheduledPostListQuerySchema,
  summary: 'List scheduled posts',
})

/** `POST /api/v1/scheduled-posts` */
export const createScheduledPostContract = defineContract({
  access: {
    apiKeyScope: 'post:schedule',
    feature: 'workspace:paid',
    permission: 'publish:manage',
    quota: 'api:write:minute',
    sensitive: true,
  },
  body: scheduledPostCreateSchema
    .extend({
      scheduledFor: z.iso
        .datetime({ offset: true })
        .transform((value) => new Date(value))
        .refine((value) => value.getTime() > Date.now(), 'Scheduled time must be in the future.')
        .describe('When to publish, as an RFC 3339 timestamp in the future.'),
    })
    .strict()
    .refine(hasOneScheduledPostSource, 'Send exactly one of variantId and contentDraftId.'),
  docs: workspaceDocs({
    bodyName: 'ScheduledPostCreateRequest',
    description:
      'Schedules an approved creative variant to an active channel connection. A variant must be `APPROVED` with an approved review; scheduling never approves. A content draft is scheduled from the draft (`POST /api/v1/content-drafts/{id}/schedule`), which checks its approval and sends its stored text: here a `contentDraftId` is refused with `409`, and with `403` for an API key. The caption is checked against the workspace’s prohibited terms and those of the account’s social set (`409`). A key also sends only text a person approved: `caption` must be the copy of an approved campaign post for this visual, otherwise `403`. To post new text, use `POST /api/v1/posts`. A key cannot schedule to an account in a private social set. Everything must belong to the workspace. Each new post counts against the monthly posts allowance. Accepts `Idempotency-Key`, unique per channel connection: a retry returns the first post with `200`, even when it recomputed the time. Without the header, the request is named by its content (source, connection, caption and time), so an identical retry also returns the first post; once that post is cancelled or failed, send a key to schedule it again. Requires the `post:schedule` scope, or a member who manages publishing, signed in within 15 minutes with two-factor.',
    operationId: 'createScheduledPost',
    responses: {
      '200': 'An earlier request with this idempotency key scheduled the post.',
      '201': 'Post scheduled.',
      '400': 'The input is invalid, or the variant or connection is not eligible.',
      '404': 'The variant or channel connection is not in this workspace.',
      '409':
        'A content draft was sent, the caption uses a prohibited term, or a request without a key names a cancelled or failed post.',
      '429': 'The monthly posts allowance or the workspace write quota is exhausted.',
    },
    tag: 'Publishing',
  }),
  headers: z.object({ 'idempotency-key': idempotencyKeySchema.optional() }),
  method: 'POST',
  name: 'scheduled-posts.create',
  output: z.object({ created: z.boolean(), scheduledPost: scheduledPostResultSchema }),
  path: '/api/v1/scheduled-posts',
  status: 201,
  summary: 'Schedule a post',
})

/** `POST /api/v1/scheduled-posts/{scheduledPostId}/cancel` */
export const cancelScheduledPostContract = defineContract({
  access: {
    apiKeyScope: 'post:schedule',
    permission: 'publish:manage',
    quota: 'api:write:minute',
    sensitive: true,
  },
  docs: workspaceDocs({
    description:
      'Cancels a post that has not started publishing. Cancelling a cancelled post returns it unchanged. A post that is processing or published cannot be cancelled; remove a published post on the social network. Requires the `post:schedule` scope, or a member who manages publishing, signed in within 15 minutes with two-factor.',
    operationId: 'cancelScheduledPost',
    responses: {
      '200': 'The post is cancelled.',
      '400': 'The scheduled post identifier is invalid.',
      '404': 'No scheduled post with that ID exists in this workspace.',
      '409': 'The post is already publishing or published.',
      '429': 'The workspace write quota is exhausted.',
    },
    tag: 'Publishing',
  }),
  method: 'POST',
  name: 'scheduled-posts.cancel',
  output: z.object({ scheduledPost: scheduledPostResultSchema }),
  params: z.object({ scheduledPostId: z.string().cuid() }),
  path: '/api/v1/scheduled-posts/{scheduledPostId}/cancel',
  summary: 'Cancel a scheduled post',
})
