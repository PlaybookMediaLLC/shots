import { z } from 'zod'
import {
  readinessCommandKeySchema,
  readinessRevisionSchema,
  releaseSourceHistorySchema,
  releaseSourcePageSchema,
  releaseSourceSelectionSchema,
  selectReleaseSourcesSchema,
} from 'screenshot-studio-backend-sdk'
import { defineContract } from '@/lib/api/contract'
import { workspaceDocs } from '@/lib/api/contracts/workspace-docs'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)

/** Read unselected or changed source evidence, optionally restricted to one release. */
export const listReleaseSourcesContract = defineContract({
  access: { apiKeyScope: 'artifact:read', permission: 'artifact:read' },
  query: z.strictObject({ releaseId: id.optional(), cursor: id.optional() }),
  docs: workspaceDocs({
    operationId: 'listReleaseSources',
    description:
      'Read at most 50 retained source objects per page. A source observation is evidence, not a human qualification decision. Retained history remains readable when the source is disconnected.',
    outputName: 'ReleaseSourcePage',
    tag: 'Workspace',
    responses: {
      '200': 'Source objects with selected and current observations.',
      '400': 'Invalid release or page cursor.',
    },
  }),
  method: 'GET',
  name: 'release-sources.list',
  path: '/api/v1/release-sources',
  output: releaseSourcePageSchema,
  summary: 'List release source evidence',
})

/** Read immutable provider observations without replacing the selected snapshot. */
export const getReleaseSourceHistoryContract = defineContract({
  access: { apiKeyScope: 'artifact:read', permission: 'artifact:read' },
  params: z.object({ id }),
  query: z.strictObject({
    cursor: readinessRevisionSchema.refine((value) => value !== '0').optional(),
  }),
  docs: workspaceDocs({
    operationId: 'getReleaseSourceHistory',
    description:
      'Read at most 50 observations of one source object. Sequence orders receipt history, while provider timestamps express known source order.',
    outputName: 'ReleaseSourceHistory',
    tag: 'Workspace',
    responses: {
      '200': 'Source history and next page cursor.',
      '400': 'Invalid source or page cursor.',
      '404': 'Source not found in this workspace.',
    },
  }),
  method: 'GET',
  name: 'release-sources.history',
  path: '/api/v1/release-sources/{id}/observations',
  output: releaseSourceHistorySchema,
  summary: 'Read release source history',
})

/** Save exact source snapshots and a release reference in the same transaction. */
export const selectReleaseSourcesContract = defineContract({
  access: {
    apiKeyScope: 'release:create',
    permission: 'release:create',
    feature: 'release:create',
    quota: 'api:write:minute',
  },
  body: selectReleaseSourcesSchema,
  headers: z.object({ 'idempotency-key': readinessCommandKeySchema }),
  docs: workspaceDocs({
    operationId: 'selectReleaseSources',
    description:
      'Select up to 200 exact observations for one existing release or atomically create a release with a human-written brief. Requires workspace readiness opt-in, expected source sequences, expected release revision and an idempotency key. Existing associations are reused explicitly; different releases are never merged by this command. Selection does not qualify, generate or publish content.',
    bodyName: 'SelectReleaseSourcesRequest',
    outputName: 'ReleaseSourceSelection',
    tag: 'Workspace',
    responses: {
      '200': 'Original result on retry.',
      '201': 'Source selection command recorded.',
      '400': 'Invalid selection, duplicate source, too many sources or missing command key.',
      '403': 'Missing permission, plan, readiness opt-in or source access.',
      '404': 'A referenced source, observation or release is not in this workspace.',
      '409':
        'Source or release changed, conflicting existing association, reused key, or aggregate source limit.',
    },
  }),
  method: 'POST',
  name: 'release-sources.select',
  path: '/api/v1/release-sources/selections',
  output: releaseSourceSelectionSchema,
  status: 201,
  summary: 'Select sources for a release',
})
