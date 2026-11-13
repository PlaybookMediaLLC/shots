import { z } from 'zod'
import { defineContract } from '@/lib/api/contract'
import { socialSetParamsSchema } from '@/lib/api/contracts/social-sets'

/**
 * Where a social set can move and what the move changes. `blocked` says why it
 * cannot move now, and `noDestination` why no workspace is offered; both are
 * empty when it can move.
 */
export const socialSetTransferPreviewSchema = z.object({
  /** Platforms whose accounts stay behind, disconnected, to connect again there. */
  accounts: z.array(z.string()),
  blocked: z.string(),
  destinations: z.array(z.object({ name: z.string(), organizationId: z.string() })),
  drafts: z.number().int(),
  mediaBytes: z.number().int(),
  mediaFiles: z.number().int(),
  noDestination: z.string(),
  /** Published posts that stay in this workspace's history. */
  publishedPosts: z.number().int(),
  /** Queued posts the move cancels; their drafts arrive unscheduled. */
  queuedPosts: z.number().int(),
  version: z.number().int(),
})

/** One of {@link socialSetTransferPreviewSchema}. */
export type SocialSetTransferPreview = z.infer<typeof socialSetTransferPreviewSchema>

/** The moved set, where it went, and the queued posts the move cancelled. */
export const socialSetTransferResultSchema = z.object({
  cancelledPostIds: z.array(z.string()),
  movedDrafts: z.number().int(),
  organizationId: z.string(),
  socialSetId: z.string(),
})

/** `GET /api/v1/social-sets/{id}/transfer` */
export const previewSocialSetTransferContract = defineContract({
  method: 'GET',
  name: 'social-sets.transfer-preview',
  output: socialSetTransferPreviewSchema,
  params: socialSetParamsSchema,
  path: '/api/v1/social-sets/{id}/transfer',
  summary: 'Preview moving a social set to another workspace',
})

/** `POST /api/v1/social-sets/{id}/transfer` */
export const transferSocialSetContract = defineContract({
  body: z
    .object({
      destinationOrganizationId: z.string().min(1).max(128),
      /** The version the preview showed; a changed set is refused. */
      version: z.number().int().min(1),
    })
    .strict(),
  method: 'POST',
  name: 'social-sets.transfer',
  output: socialSetTransferResultSchema,
  params: socialSetParamsSchema,
  path: '/api/v1/social-sets/{id}/transfer',
  summary: 'Move a social set to another workspace',
})
