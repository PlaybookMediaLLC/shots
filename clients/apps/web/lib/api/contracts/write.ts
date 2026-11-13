import { z } from 'zod'
import { defineContract, timestampSchema } from '@/lib/api/contract'
import {
  contentDraftIdSchema,
  contentDraftParamsSchema,
  contentDraftPostSchema,
  contentDraftSchema,
} from '@/lib/api/contracts/content-drafts'
import { workspaceDocs } from '@/lib/api/contracts/workspace-docs'

/**
 * A draft's Write operations (RFC 025): its organizing properties, plan,
 * duplicates and copies, recovered backups and activity. They take an API
 * key with the drafts scopes. Nothing here publishes.
 */

const entitlement = {
  'x-shots-entitlement': { feature: 'content:drafts', minimumPlan: 'free' },
}
/** A draft's organizing properties; none of them is content. */
export const draftPropertiesInputSchema = z.strictObject({
  addTagIds: z.array(contentDraftIdSchema).max(20).optional(),
  pinned: z.boolean().optional(),
  removeTagIds: z.array(contentDraftIdSchema).max(20).optional(),
  scratchpad: z.string().max(20_000).optional(),
  suppressSlackOnPublish: z.boolean().optional(),
})

/** `PATCH /api/v1/content-drafts/{id}/properties` */
export const updateDraftPropertiesContract = defineContract({
  access: { apiKeyScope: 'draft:write', feature: 'content:drafts', permission: 'artifact:edit' },
  body: draftPropertiesInputSchema,
  docs: workspaceDocs({
    description:
      "Pins, tags, or annotates a draft. Properties are not content: the draft's version, and any approval of it, stay. Tags are added and removed by id, so concurrent taggers both count.",
    extensions: entitlement,
    operationId: 'updateContentDraftProperties',
    outputName: 'ContentDraft',
    responses: {
      '200': 'The draft.',
      '400': "A tag is not in the draft's set.",
      '404': 'The draft was not found.',
    },
    tag: 'Workspace',
  }),
  method: 'PATCH',
  name: 'content-drafts.properties',
  output: contentDraftSchema,
  params: contentDraftParamsSchema,
  path: '/api/v1/content-drafts/{id}/properties',
  summary: "Update a draft's pin, tags, or scratchpad",
})

/** A plan: a future time and its zone, or null to clear it. */
export const draftPlanInputSchema = z.strictObject({
  /** Omitted legacy revisions can only initialize a never-planned draft. */
  baseCalendarVersion: z.number().int().positive().optional(),
  plannedFor: z.iso.datetime({ offset: true }).nullable(),
  timeZone: z.string().max(80).optional(),
})

/** `POST /api/v1/content-drafts/{id}/plan` */
export const planContentDraftContract = defineContract({
  access: { apiKeyScope: 'draft:write', feature: 'content:drafts', permission: 'artifact:edit' },
  body: draftPlanInputSchema,
  docs: workspaceDocs({
    description:
      'Puts a draft on the calendar at a time, or takes it off. A plan creates no scheduled post: a planned draft never publishes when its time passes.',
    extensions: entitlement,
    operationId: 'planContentDraft',
    outputName: 'ContentDraft',
    responses: {
      '200': 'The draft.',
      '400': 'The time is past or the zone unknown.',
      '404': 'The draft was not found.',
    },
    tag: 'Workspace',
  }),
  method: 'POST',
  name: 'content-drafts.plan',
  output: contentDraftSchema,
  params: contentDraftParamsSchema,
  path: '/api/v1/content-drafts/{id}/plan',
  summary: 'Plan a draft on the calendar',
})

/** A new draft and what the destination could not take. */
export const draftCopyResultSchema = z.object({
  draft: contentDraftSchema,
  /** `platform:<channel>` or `tag:<name>` for each thing left behind. */
  dropped: z.array(z.string()),
})

/** `POST /api/v1/content-drafts/{id}/duplicate` */
export const duplicateContentDraftContract = defineContract({
  access: { apiKeyScope: 'draft:write', feature: 'content:drafts', permission: 'artifact:edit' },
  docs: workspaceDocs({
    description:
      'Duplicates a draft in its social set: a new draft at version 1 with the same writing, destinations and tags, and no share link, comments, review, plan or scheduled posts.',
    extensions: entitlement,
    operationId: 'duplicateContentDraft',
    outputName: 'ContentDraftCopy',
    responses: {
      '201': 'The copy.',
      '404': 'The draft was not found.',
      '409': 'An image was deleted.',
    },
    tag: 'Workspace',
  }),
  method: 'POST',
  name: 'content-drafts.duplicate',
  query: z.object({ requestKey: z.string().min(1).max(200).optional() }),
  output: draftCopyResultSchema,
  params: contentDraftParamsSchema,
  path: '/api/v1/content-drafts/{id}/duplicate',
  status: 201,
  summary: 'Duplicate a draft',
})

/** How a copy treats tags: match the destination set's tags by name, or drop them. */
export const tagModeSchema = z.enum(['match', 'drop'])

/** `POST /api/v1/content-drafts/{id}/copy` */
export const copyContentDraftContract = defineContract({
  access: { apiKeyScope: 'draft:write', feature: 'content:drafts', permission: 'artifact:edit' },
  body: z.strictObject({ socialSetId: contentDraftIdSchema, tagMode: tagModeSchema }),
  docs: workspaceDocs({
    description:
      "Copies a draft into another social set. Destinations become that set's accounts on the same platforms; platforms it lacks, and unmatched tags, are reported in `dropped`.",
    extensions: entitlement,
    operationId: 'copyContentDraft',
    outputName: 'ContentDraftCopy',
    responses: { '201': 'The copy.', '404': 'The draft or set was not found.' },
    tag: 'Workspace',
  }),
  method: 'POST',
  name: 'content-drafts.copy',
  output: draftCopyResultSchema,
  params: contentDraftParamsSchema,
  path: '/api/v1/content-drafts/{id}/copy',
  status: 201,
  summary: 'Copy a draft to another social set',
})

/** `POST /api/v1/content-drafts/{id}/revisions/{revisionId}/recover` */
export const recoverContentDraftRevisionContract = defineContract({
  access: { apiKeyScope: 'draft:write', feature: 'content:drafts', permission: 'artifact:edit' },
  docs: workspaceDocs({
    description:
      'Creates a new draft from an automatic backup. The source draft is left exactly as it is, and the new draft has no publication state.',
    extensions: entitlement,
    operationId: 'recoverContentDraftRevision',
    outputName: 'ContentDraftCopy',
    responses: { '201': 'The recovered draft.', '404': 'The draft or backup was not found.' },
    tag: 'Workspace',
  }),
  method: 'POST',
  name: 'content-drafts.recover',
  output: draftCopyResultSchema,
  params: contentDraftParamsSchema.extend({ revisionId: contentDraftIdSchema }),
  path: '/api/v1/content-drafts/{id}/revisions/{revisionId}/recover',
  status: 201,
  summary: 'Recover a backup as a new draft',
})

/** One event in a draft's history. */
export const draftActivitySchema = z.object({
  action: z.string(),
  actorName: z.string().nullable(),
  actorType: z.string(),
  actorUserId: z.string().nullable(),
  at: timestampSchema,
  entityId: z.string(),
  id: z.string(),
  /** References only: ids, versions, field names. Never the draft's text. */
  metadata: z.record(z.string(), z.unknown()),
})

/** One of {@link draftActivitySchema}. */
export type DraftActivity = z.infer<typeof draftActivitySchema>

/** `GET /api/v1/content-drafts/{id}/activity` */
export const contentDraftActivityContract = defineContract({
  access: { apiKeyScope: 'artifact:read', feature: 'content:drafts', permission: 'artifact:read' },
  docs: workspaceDocs({
    description:
      "Lists a draft's history, newest first: creation, edits, renames, destinations, tags, review, sharing, planning, scheduling, publication and recovery, with who and when. Viewing a draft is never recorded.",
    extensions: entitlement,
    operationId: 'listContentDraftActivity',
    outputName: 'ContentDraftActivityList',
    responses: { '200': 'The activity.', '404': 'The draft was not found.' },
    tag: 'Workspace',
  }),
  method: 'GET',
  name: 'content-drafts.activity',
  output: z.object({ items: z.array(draftActivitySchema) }),
  params: contentDraftParamsSchema,
  path: '/api/v1/content-drafts/{id}/activity',
  summary: "List a draft's activity",
})

/** `GET /api/v1/content-draft-plans` */
export const listPlannedContentDraftsContract = defineContract({
  method: 'GET',
  name: 'content-drafts.plans',
  output: z.object({ items: z.array(contentDraftSchema) }),
  path: '/api/v1/content-draft-plans',
  query: z.object({
    from: z.iso.datetime({ offset: true }),
    socialSetId: contentDraftIdSchema.optional(),
    to: z.iso.datetime({ offset: true }),
  }),
  summary: 'List drafts planned between two times',
})

/** `POST /api/v1/content-draft-posts/{id}/retry` */
export const retryDraftPostContract = defineContract({
  method: 'POST',
  name: 'content-draft-posts.retry',
  output: z.object({ post: contentDraftPostSchema }),
  params: z.object({ id: contentDraftIdSchema }),
  path: '/api/v1/content-draft-posts/{id}/retry',
  status: 201,
  summary: 'Publish one failed destination again, once',
})

/** What a person found on the platform for a post of unknown outcome. */
export const reconcileInputSchema = z.strictObject({
  live: z.boolean(),
  url: z
    .url({ protocol: /^https$/ })
    .max(2_048)
    .optional(),
})

/** `POST /api/v1/content-draft-posts/{id}/reconcile` */
export const reconcileDraftPostContract = defineContract({
  body: reconcileInputSchema,
  method: 'POST',
  name: 'content-draft-posts.reconcile',
  output: z.object({ post: contentDraftPostSchema }),
  params: z.object({ id: contentDraftIdSchema }),
  path: '/api/v1/content-draft-posts/{id}/reconcile',
  summary: 'Settle a post whose outcome is unknown, without contacting the platform',
})

/** A delete Shots started: the workflow removes the post's parts with receipts. */
export const postDeletionSchema = z.object({
  organizationId: z.string(),
  platform: z.string(),
  postId: z.string(),
  requestedBy: z.string(),
})

/** `POST /api/v1/content-draft-posts/{id}/delete` */
export const deleteDraftPostContract = defineContract({
  access: { apiKeyScope: 'post:delete', feature: 'content:drafts', permission: 'publish:manage' },
  docs: workspaceDocs({
    description:
      'Deletes a post that Shots published from its platform, with its thread parts, the replies Shots posted and its reposts. Each part gets a receipt; a part the platform already removed counts as deleted. Platforms without a delete call record the part as unsupported. Requires the `post:delete` scope.',
    extensions: entitlement,
    operationId: 'deleteContentDraftPost',
    outputName: 'PostDeletion',
    responses: {
      '202': 'The delete started.',
      '403': 'The caller may not publish to this account, or the key lacks `post:delete`.',
      '404': 'The post was not found in this workspace.',
      '409': 'The post is not live, or it was already deleted.',
    },
    tag: 'Workspace',
  }),
  method: 'POST',
  name: 'content-draft-posts.delete',
  output: z.object({ deletion: postDeletionSchema }),
  params: z.object({ id: contentDraftIdSchema }),
  path: '/api/v1/content-draft-posts/{id}/delete',
  status: 202,
  summary: 'Delete a published post from its platform',
})

/** `POST /api/v1/content-draft-posts/{id}/automations/cancel` */
export const cancelDraftPostAutomationsContract = defineContract({
  method: 'POST',
  name: 'content-draft-posts.automations.cancel',
  output: z.object({ post: contentDraftPostSchema }),
  params: z.object({ id: contentDraftIdSchema }),
  path: '/api/v1/content-draft-posts/{id}/automations/cancel',
  summary: "Stop a live post's pending follow-ups; removals of automatic reposts still run",
})
