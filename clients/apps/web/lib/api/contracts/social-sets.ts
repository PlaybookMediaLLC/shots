import { z } from 'zod'
import { draftChannelSchema } from '@/lib/write/document'
import { workspaceDocs } from '@/lib/api/contracts/workspace-docs'
import { socialAccountSchema } from 'screenshot-studio-backend-sdk'
import type { SocialSet, SocialSetList, WritingSample } from 'screenshot-studio-backend-sdk'
import { defineContract, mirrors } from '@/lib/api/contract'
import { contentDraftIdSchema } from '@/lib/api/contracts/content-drafts'
import { isoInstantSchema } from '@/lib/api/contracts/settings-platform'

/**
 * Social sets (RFC 024): publishing identities with their accounts, schedules,
 * new-draft defaults, public profiles and Writing Assistant. Each schema
 * mirrors the backend SDK's type, so the Go contract and this one cannot drift.
 */

/** The SDK owns the provider-account wire contract. */
export { socialAccountHealthSchema, socialAccountSchema } from 'screenshot-studio-backend-sdk'

/** One X follow-up a new draft starts with. */
export const engagementRuleSchema = z.object({
  atLikes: z.number().int().min(0).max(1_000_000),
  enabled: z.boolean(),
  text: z.string().max(1_000).optional(),
})

/** A set's default X follow-ups. */
export const engagementSchema = z.object({
  autoPlug: engagementRuleSchema,
  autoRepost: engagementRuleSchema,
})

/** A draft platform a default or guidance can name. */
export const draftPlatformSchema = draftChannelSchema

/** How a set writes; it refines the workspace brand voice. */
export const styleGuideSchema = z.object({
  audience: z.string().max(300),
  endings: z.array(z.string().max(280)).max(10),
  formatting: z.string().max(600),
  openings: z.array(z.string().max(280)).max(10),
  platformGuidance: z.record(z.string(), z.string().max(600)),
  prohibitedPhrases: z.array(z.string().max(80)).max(30),
  terminology: z.array(z.string().max(80)).max(30),
  tone: z.string().max(300),
})

/** A Writing Assistant's lifecycle. */
export const writingAssistantStatusSchema = z.enum([
  'not_configured',
  'in_progress',
  'configured',
  'disabled',
  'attention',
])

/** How many weekly posting slots a set may have; the backend enforces the same. */
export const POSTING_SLOT_LIMIT = 50

/** A weekly posting slot: a weekday (0 is Sunday) and a time as HH:MM. */
export const weeklySlotSchema = z.object({
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  weekday: z.number().int().min(0).max(6),
})

/** Shared with the workspace, or private to its owner. */
export const socialSetVisibilitySchema = z.enum(['WORKSPACE', 'PRIVATE'])

/** A publishing identity. */
export const socialSetSchema = mirrors<SocialSet>()(
  z.object({
    accounts: z.array(socialAccountSchema),
    color: z.string(),
    createdAt: isoInstantSchema,
    defaultPlatforms: z.array(z.string()),
    engagementDefaults: engagementSchema,
    id: z.string(),
    isOwner: z.boolean(),
    name: z.string(),
    naturalPostingTimes: z.boolean(),
    needsAttention: z.boolean(),
    ownerUserId: z.string().nullable(),
    postingSlots: z.array(weeklySlotSchema),
    primaryPlatform: z.string().nullable(),
    publicProfile: z.boolean(),
    publicSlug: z.string(),
    timeZone: z.string(),
    updatedAt: isoInstantSchema,
    version: z.number().int(),
    visibility: socialSetVisibilitySchema,
    weeklySlotCount: z.number().int(),
    writingAssistant: z.object({
      configuredAt: isoInstantSchema.nullable(),
      sampleCount: z.number().int(),
      status: writingAssistantStatusSchema,
      styleGuide: styleGuideSchema,
    }),
  })
)

/** The sets you see, accounts in no set, and private sets left behind. */
export const socialSetListSchema = mirrors<SocialSetList>()(
  z.object({
    items: z.array(socialSetSchema),
    orphaned: z.array(
      z.object({ accountCount: z.number().int(), id: z.string(), name: z.string() })
    ),
    unassigned: z.array(socialAccountSchema),
  })
)

/** Path parameters naming one set. */
export const socialSetParamsSchema = z.object({ id: contentDraftIdSchema })

/** Path parameters naming one account of one set. */
export const socialSetAccountParamsSchema = z.object({
  connectionId: contentDraftIdSchema,
  id: contentDraftIdSchema,
})

/** `GET /api/v1/social-sets` */
export const listSocialSetsContract = defineContract({
  access: { apiKeyScope: 'artifact:read', feature: 'content:drafts', permission: 'artifact:read' },
  docs: workspaceDocs({
    operationId: 'listSocialSets',
    description:
      'Lists workspace-visible social sets and their connected identities, posting schedule, and defaults. Private member sets are excluded for API keys.',
    extensions: { 'x-shots-entitlement': { feature: 'content:drafts' } },
    responses: { '200': 'The authorized result.', '404': 'The social set is unavailable.' },
    tag: 'Workspace',
  }),
  method: 'GET',
  name: 'social-sets.list',
  output: socialSetListSchema,
  path: '/api/v1/social-sets',
  summary: 'List your social sets',
})

/** `POST /api/v1/social-sets` */
export const createSocialSetContract = defineContract({
  body: z
    .object({
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
      name: z.string().trim().min(1).max(80),
      timeZone: z.string().max(64).optional(),
      visibility: socialSetVisibilitySchema.optional(),
    })
    .strict(),
  method: 'POST',
  name: 'social-sets.create',
  output: socialSetSchema,
  path: '/api/v1/social-sets',
  status: 201,
  summary: 'Create a social set',
})

/** `GET /api/v1/social-sets/{id}` */
export const getSocialSetContract = defineContract({
  access: { apiKeyScope: 'artifact:read', feature: 'content:drafts', permission: 'artifact:read' },
  docs: workspaceDocs({
    operationId: 'getSocialSet',
    description:
      'Reads one visible social set including its posting schedule. Reading never changes approval or publishing permissions.',
    extensions: { 'x-shots-entitlement': { feature: 'content:drafts' } },
    responses: { '200': 'The authorized result.', '404': 'The social set is unavailable.' },
    tag: 'Workspace',
  }),
  method: 'GET',
  name: 'social-sets.get',
  output: socialSetSchema,
  params: socialSetParamsSchema,
  path: '/api/v1/social-sets/{id}',
  summary: 'Read a social set',
})

/** A set's settings save, based on the version you read. */
export const socialSetUpdateSchema = z
  .object({
    baseVersion: z.number().int().min(1),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    defaultPlatforms: z.array(draftPlatformSchema).max(10).optional(),
    engagementDefaults: engagementSchema.optional(),
    name: z.string().trim().min(1).max(80).optional(),
    naturalPostingTimes: z.boolean().optional(),
    postingSlots: z.array(weeklySlotSchema).max(POSTING_SLOT_LIMIT).optional(),
    primaryPlatform: z.union([draftPlatformSchema, z.literal('')]).optional(),
    publicProfile: z.boolean().optional(),
    timeZone: z.string().max(64).optional(),
  })
  .strict()

/** `PATCH /api/v1/social-sets/{id}` */
export const updateSocialSetContract = defineContract({
  body: socialSetUpdateSchema,
  method: 'PATCH',
  name: 'social-sets.update',
  output: socialSetSchema,
  params: socialSetParamsSchema,
  path: '/api/v1/social-sets/{id}',
  summary: 'Save a social set',
})

/** What removing an account or deleting a set did. */
export const socialSetRemovalSchema = z.object({
  cancelledPostIds: z.array(z.string()),
  draftsArchived: z.number().int(),
})

/** `DELETE /api/v1/social-sets/{id}` */
export const deleteSocialSetContract = defineContract({
  body: z.object({ confirmation: z.string().min(1).max(80) }).strict(),
  method: 'DELETE',
  name: 'social-sets.delete',
  output: socialSetRemovalSchema,
  params: socialSetParamsSchema,
  path: '/api/v1/social-sets/{id}',
  summary: 'Delete a social set',
})

/** `POST /api/v1/social-sets/{id}/share` */
export const shareSocialSetContract = defineContract({
  method: 'POST',
  name: 'social-sets.share',
  output: socialSetSchema,
  params: socialSetParamsSchema,
  path: '/api/v1/social-sets/{id}/share',
  summary: 'Share a private social set with the workspace',
})

/** `POST /api/v1/social-sets/{id}/accounts/{connectionId}` */
export const assignSocialSetAccountContract = defineContract({
  method: 'POST',
  name: 'social-sets.account-add',
  output: socialSetSchema,
  params: socialSetAccountParamsSchema,
  path: '/api/v1/social-sets/{id}/accounts/{connectionId}',
  summary: 'Add an account that is in no set to a social set',
})

/** `POST /api/v1/social-sets/{id}/accounts/{connectionId}/move` */
export const moveSocialSetAccountContract = defineContract({
  body: z.object({ destinationSocialSetId: contentDraftIdSchema }).strict(),
  method: 'POST',
  name: 'social-sets.account-move',
  output: socialSetSchema,
  params: socialSetAccountParamsSchema,
  path: '/api/v1/social-sets/{id}/accounts/{connectionId}/move',
  summary: 'Move a connected account to another profile in this workspace',
})

/** `DELETE /api/v1/social-sets/{id}/accounts/{connectionId}` */
export const removeSocialSetAccountContract = defineContract({
  method: 'DELETE',
  name: 'social-sets.account-remove',
  output: socialSetRemovalSchema,
  params: socialSetAccountParamsSchema,
  path: '/api/v1/social-sets/{id}/accounts/{connectionId}',
  summary: 'Remove an account from a social set',
})

/** A set of another of your workspaces. */
export const copyableSocialSetSchema = z.object({
  id: z.string(),
  name: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
})

/** `GET /api/v1/social-sets/copyable` */
export const listCopyableSocialSetsContract = defineContract({
  method: 'GET',
  name: 'social-sets.copyable',
  output: z.object({ items: z.array(copyableSocialSetSchema) }),
  path: '/api/v1/social-sets/copyable',
  summary: 'List social sets of your other workspaces',
})

/** `POST /api/v1/social-sets/copy` */
export const copySocialSetContract = defineContract({
  body: z
    .object({ socialSetId: contentDraftIdSchema, workspaceId: z.string().min(1).max(64) })
    .strict(),
  method: 'POST',
  name: 'social-sets.copy',
  output: socialSetSchema,
  path: '/api/v1/social-sets/copy',
  status: 201,
  summary: "Copy another workspace's social set here, without its accounts",
})

/** `PUT /api/v1/social-sets/{id}/writing-assistant` */
export const updateWritingAssistantContract = defineContract({
  body: z
    .object({
      action: z.enum(['create', 'disable', 'enable']).optional(),
      baseVersion: z.number().int().min(1),
      styleGuide: styleGuideSchema.optional(),
    })
    .strict(),
  method: 'PUT',
  name: 'social-sets.writing-assistant',
  output: socialSetSchema,
  params: socialSetParamsSchema,
  path: '/api/v1/social-sets/{id}/writing-assistant',
  summary: "Save a social set's Writing Assistant",
})

/** One writing sample. */
export const writingSampleSchema = mirrors<WritingSample>()(
  z.object({
    createdAt: isoInstantSchema,
    createdByUserId: z.string().nullable(),
    id: z.string(),
    source: z.enum(['manual', 'draft']),
    sourceDraftId: z.string().nullable(),
    text: z.string(),
  })
)

/** `GET /api/v1/social-sets/{id}/writing-samples` */
export const listWritingSamplesContract = defineContract({
  method: 'GET',
  name: 'social-sets.writing-samples',
  output: z.object({ items: z.array(writingSampleSchema) }),
  params: socialSetParamsSchema,
  path: '/api/v1/social-sets/{id}/writing-samples',
  summary: "List a social set's writing samples",
})

/** `POST /api/v1/social-sets/{id}/writing-samples` */
export const addWritingSampleContract = defineContract({
  body: z.union([
    z.object({ text: z.string().trim().min(1).max(5_000) }).strict(),
    z.object({ draftId: contentDraftIdSchema }).strict(),
  ]),
  method: 'POST',
  name: 'social-sets.writing-sample-add',
  output: writingSampleSchema,
  params: socialSetParamsSchema,
  path: '/api/v1/social-sets/{id}/writing-samples',
  status: 201,
  summary: 'Add a writing sample, written here or imported from a draft of the set',
})

/** `DELETE /api/v1/social-sets/{id}/writing-samples/{sampleId}` */
export const deleteWritingSampleContract = defineContract({
  method: 'DELETE',
  name: 'social-sets.writing-sample-delete',
  output: z.object({ deleted: z.literal(true) }),
  params: socialSetParamsSchema.extend({ sampleId: contentDraftIdSchema }),
  path: '/api/v1/social-sets/{id}/writing-samples/{sampleId}',
  summary: 'Remove a writing sample',
})
