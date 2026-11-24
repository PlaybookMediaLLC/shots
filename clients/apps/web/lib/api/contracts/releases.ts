import { z } from 'zod'
import { defineContract, mirrors, timestampSchema } from '@/lib/api/contract'
import { workspaceDocs } from '@/lib/api/contracts/workspace-docs'
import type { createRelease, listReleases } from '@/lib/tenant/releases'
import { releaseCreateSchema, releaseListQuerySchema } from '@/lib/tenant/schemas'

/** Lifecycle states of a release. */
export const releaseStatusSchema = z.enum(['DRAFT', 'READY', 'ARCHIVED', 'CANCELLED'])

/** What a release's features are, for announcing: features and improvements are news. */
export const releaseFeatureKindSchema = z.enum([
  'feature',
  'improvement',
  'fix',
  'internal',
  'other',
])

/** One line of a release, read from its notes or a merged pull request. */
export const releaseFeatureSchema = z.object({
  author: z.string().optional(),
  kind: releaseFeatureKindSchema,
  number: z.number().int().optional(),
  title: z.string(),
  url: z.string().optional(),
})

/** A release as listed and created. */
export const releaseSummarySchema = z.object({
  id: z.string(),
  productSurfaceId: z.string().nullable(),
  status: releaseStatusSchema,
  title: z.string(),
})

/** Release choices shared by source selection and grouping in the browser. */
export const releaseChoicesSchema = z.object({ releases: z.array(releaseSummarySchema) })

/**
 * A client idempotency key. Longer keys are rejected, not truncated, so two
 * long keys can never collide.
 */
export const idempotencyKeySchema = z.string().trim().max(128)

/** `GET /api/v1/releases` (also served at `/api/tenant/releases`). */
export const listReleasesContract = defineContract({
  access: {
    apiKeyScope: 'artifact:read',
    feature: 'workspace:paid',
    permission: 'artifact:read',
  },
  docs: workspaceDocs({
    description: 'Lists releases in the API key workspace. Requires the `artifact:read` scope.',
    operationId: 'listReleases',
    outputName: 'ReleaseListResponse',
    responses: { '200': 'Workspace releases.', '400': 'The list query is invalid.' },
    tag: 'Workspace',
  }),
  method: 'GET',
  name: 'releases.list',
  output: z.object({
    releases: mirrors<Awaited<ReturnType<typeof listReleases>>>()(
      z.array(
        releaseSummarySchema.extend({
          benefitStatement: z.string(),
          createdAt: timestampSchema,
          features: z.array(releaseFeatureSchema).optional(),
          screenshotAssetIds: z.array(z.string()).optional(),
          updatedAt: timestampSchema,
        })
      )
    ),
  }),
  path: '/api/v1/releases',
  query: releaseListQuerySchema,
  summary: 'List workspace releases',
})

/** `POST /api/v1/releases` (also served at `/api/tenant/releases`). */
export const createReleaseContract = defineContract({
  access: {
    apiKeyScope: 'release:create',
    feature: 'release:create',
    permission: 'release:create',
    quota: 'api:write:minute',
  },
  body: releaseCreateSchema,
  docs: workspaceDocs({
    bodyName: 'ReleaseCreateRequest',
    description:
      'Creates a release in the API key workspace. Accepts `Idempotency-Key` and requires the `release:create` scope.',
    operationId: 'createRelease',
    responses: {
      '200': 'An existing idempotent result.',
      '201': 'Release created.',
      '400': 'The release input is invalid.',
    },
    tag: 'Workspace',
  }),
  headers: z.object({ 'idempotency-key': idempotencyKeySchema.optional() }),
  method: 'POST',
  name: 'releases.create',
  output: mirrors<Awaited<ReturnType<typeof createRelease>>>()(
    z.object({ created: z.boolean(), release: releaseSummarySchema })
  ),
  path: '/api/v1/releases',
  status: 201,
  summary: 'Create a workspace release',
})
