import { defineContract } from '@/lib/api/contract'
import { workspaceDocs } from '@/lib/api/contracts/workspace-docs'
import {
  socialSetParamsSchema,
  socialSetSchema,
  socialSetUpdateSchema,
} from '@/lib/api/contracts/social-sets'

/** Queue defaults are a versioned subset; no identity or approval fields. */
export const socialSetQueueUpdateSchema = socialSetUpdateSchema
  .pick({
    baseVersion: true,
    postingSlots: true,
    timeZone: true,
    naturalPostingTimes: true,
    naturalPostingWindowMinutes: true,
  })
  .refine(
    (value) =>
      value.postingSlots !== undefined ||
      value.timeZone !== undefined ||
      value.naturalPostingTimes !== undefined ||
      value.naturalPostingWindowMinutes !== undefined,
    'Choose a queue setting to change.'
  )

/** `PATCH /api/v1/social-sets/{id}/queue` changes future slot suggestions. */
export const updateSocialSetQueueContract = defineContract({
  access: {
    apiKeyScope: 'queue:write',
    feature: 'content:drafts',
    permission: 'connection:manage',
    quota: 'api:write:minute',
  },
  body: socialSetQueueUpdateSchema,
  docs: workspaceDocs({
    operationId: 'updateSocialSetQueue',
    description:
      'Changes weekly posting slots, time zone, or natural-time variation for a workspace-visible social set. Requires its current baseVersion; concurrent or repeated writes return 409. Only future slot suggestions change. Existing scheduled and planned times, approval requirements, and connected identities remain unchanged. API keys require the separate queue:write scope; draft:write does not imply it. Private social sets remain unavailable to keys.',
    extensions: { 'x-shots-entitlement': { feature: 'content:drafts', quota: 'api:write:minute' } },
    responses: {
      '200': 'Updated social set.',
      '404': 'Social set unavailable.',
      '409': 'Reload the set and reconcile its changed version.',
    },
    tag: 'Workspace',
  }),
  method: 'PATCH',
  name: 'social-sets.queue-update',
  output: socialSetSchema,
  params: socialSetParamsSchema,
  path: '/api/v1/social-sets/{id}/queue',
  summary: 'Update future queue slots',
})
