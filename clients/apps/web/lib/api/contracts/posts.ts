import { z } from 'zod'
import { defineContract } from '@/lib/api/contract'
import {
  contentDraftIdSchema,
  contentDraftPostSchema,
  contentDraftSchema,
} from '@/lib/api/contracts/content-drafts'
import { workspaceDocs } from '@/lib/api/contracts/workspace-docs'
import { getMinimumPlan } from '@/lib/billing/plans'
import { draftChannelSchema, versionOptionsSchema } from '@/lib/write/document'
import { scheduleTimingSchema } from '@/lib/write/wire'

const entitlement = {
  'x-shots-entitlement': {
    feature: 'content:drafts',
    minimumPlan: getMinimumPlan('content:drafts'),
  },
}

/** One post of a thread: its text, and uploaded assets to attach. */
const postPartSchema = z.strictObject({
  assetIds: z.array(contentDraftIdSchema).max(20).optional(),
  text: z.string().max(100_000),
})

/** A post or thread: two or more parts post as replies to the first. */
const postPartsSchema = z.array(postPartSchema).min(1).max(25)

/** A new post, or thread, and when it goes out. */
export const createPostSchema = scheduleTimingSchema
  .extend({
    channelConnectionIds: z
      .array(contentDraftIdSchema)
      .min(1)
      .max(10)
      .describe('The accounts to post to: `accounts[].id` from `GET /api/v1/social-sets`.'),
    platforms: z
      .partialRecord(
        draftChannelSchema,
        z.strictObject({
          options: versionOptionsSchema
            .pick({
              facebook: true,
              firstComment: true,
              pinterest: true,
              tiktok: true,
              visibility: true,
              youtube: true,
            })
            .optional(),
          posts: postPartsSchema.optional(),
        })
      )
      .optional()
      .describe("What a platform posts instead of `posts`, and that platform's settings."),
    posts: postPartsSchema,
    queue: z.boolean().optional(),
    scheduledFor: z.iso
      .datetime({ offset: true })
      .optional()
      .describe('When to publish, as an RFC 3339 timestamp in the future.'),
    title: z.string().max(200).optional(),
  })
  .strict()

/**
 * `POST /api/v1/posts`: write a post and put it on channels in one call. It is
 * how a key or agent posts: finished text, not a composer document. It needs
 * the opt-in `post:publish` scope, which `post:schedule` does not imply.
 */
export const createPostContract = defineContract({
  access: {
    apiKeyScope: 'post:publish',
    feature: 'content:drafts',
    permission: 'publish:manage',
    quota: 'api:write:minute',
  },
  body: createPostSchema,
  docs: workspaceDocs({
    bodyName: 'PostCreateRequest',
    description:
      "Writes a post or thread and schedules or publishes it to accounts of one shared social set, with no review by a person. Say when with exactly one of `publishNow`, `scheduledFor`, `localTime`, and `queue`. A workspace that requires approval keeps that rule: the draft is created, nothing is queued, and `status` is `awaiting_approval` with a `reviewPath`. Every check runs first, so a refused post leaves no draft. Each account's post counts against the monthly posts allowance. Requires `Idempotency-Key`: a retry with the same key and content returns the first result with `200` and never posts twice. A published post can't be recalled by retrying, so read the post's status with `GET /api/v1/content-drafts/{id}/posts` rather than posting again. Requires the `post:publish` scope, which no key has unless someone chose it.",
    extensions: entitlement,
    operationId: 'createPost',
    responses: {
      '200':
        'An earlier request with this idempotency key made this post, or the draft is waiting for approval.',
      '201': 'The post is scheduled or publishing.',
      '400': 'The input is invalid.',
      '404': 'An account is not in this workspace, or is in a private social set.',
      '409':
        "An account or the post can't publish as written, such as text over a platform's limit or an account that needs reconnecting. Nothing was created.",
      '429': 'The monthly posts allowance or the workspace write quota is exhausted.',
    },
    tag: 'Publishing',
  }),
  headers: z.object({ 'idempotency-key': z.string().trim().min(16).max(128) }),
  method: 'POST',
  name: 'posts.create',
  output: z.object({
    created: z.boolean(),
    draft: contentDraftSchema,
    posts: z.array(contentDraftPostSchema),
    reviewPath: z.string().optional(),
    status: z.enum(['awaiting_approval', 'publishing', 'scheduled']),
  }),
  path: '/api/v1/posts',
  status: 201,
  summary: 'Write and publish a post',
})
