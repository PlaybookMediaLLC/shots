import { z } from 'zod'
import {
  createQualificationSchema,
  decideQualificationSchema,
  qualificationResultSchema,
  qualificationRevisionSchema,
  readinessCommandKeySchema,
  releaseQualificationSchema,
  mergeReleaseSchema,
  splitReleaseSchema,
  releaseLineageResultSchema,
  releaseLineageHistorySchema,
} from 'screenshot-studio-backend-sdk'
import { defineContract } from '@/lib/api/contract'
import { memberDocs, workspaceDocs } from '@/lib/api/contracts/workspace-docs'

const params = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) })
const headers = z.object({ 'idempotency-key': readinessCommandKeySchema })

/** Read one prior version without replacing the current qualification. */
export const getQualificationRevisionContract = defineContract({
  access: { apiKeyScope: 'artifact:read', permission: 'artifact:read' },
  docs: workspaceDocs({
    operationId: 'getQualificationRevision',
    description:
      'Read immutable release facts and their recorded human decision, including when qualification is disabled.',
    outputName: 'QualificationRevision',
    tag: 'Workspace',
    responses: {
      '200': 'Saved facts and decision.',
      '404': 'Revision not found for this release in this workspace.',
    },
  }),
  method: 'GET',
  name: 'releases.qualification.revision',
  path: '/api/v1/releases/{id}/qualification/revisions/{revisionId}',
  params: params.extend({ revisionId: params.shape.id }),
  output: qualificationRevisionSchema,
  summary: 'Read a saved qualification version',
})

/** Current qualification remains readable when the pilot flag is disabled. */
export const getReleaseQualificationContract = defineContract({
  access: { apiKeyScope: 'artifact:read', permission: 'artifact:read' },
  docs: workspaceDocs({
    operationId: 'getReleaseQualification',
    description:
      'Read human qualification separately from campaign status, including facts that need repair.',
    outputName: 'ReleaseQualification',
    tag: 'Workspace',
    responses: {
      '200': 'Current qualification and missing facts.',
      '404': 'Release not found in this workspace.',
    },
  }),
  method: 'GET',
  name: 'releases.qualification.get',
  path: '/api/v1/releases/{id}/qualification',
  params,
  output: releaseQualificationSchema,
  summary: 'Read release qualification',
})

/** Save incomplete facts as an immutable revision; never infer a human decision. */
export const createQualificationContract = defineContract({
  access: {
    apiKeyScope: 'release:create',
    permission: 'release:create',
    feature: 'release:create',
    quota: 'api:write:minute',
  },
  body: createQualificationSchema,
  headers,
  params,
  docs: workspaceDocs({
    operationId: 'createQualificationRevision',
    description:
      'Append a factual revision using an expected revision and required idempotency key. Incomplete facts remain unqualified.',
    bodyName: 'CreateQualificationRequest',
    outputName: 'QualificationCommandResult',
    tag: 'Workspace',
    responses: {
      '200': 'Original result on retry.',
      '201': 'New facts revision.',
      '400': 'Invalid facts or missing command key.',
      '409': 'Stale revision or reused command key.',
    },
  }),
  method: 'POST',
  name: 'releases.qualification.revise',
  path: '/api/v1/releases/{id}/qualification/revisions',
  output: qualificationResultSchema,
  status: 201,
  summary: 'Save release facts for review',
})

/** Only the assigned human reviewer can qualify, decline, defer, withdraw or reopen. */
export const decideQualificationContract = defineContract({
  access: { permission: 'release:approve', feature: 'release:create', quota: 'api:write:minute' },
  body: decideQualificationSchema,
  headers,
  params,
  docs: memberDocs({
    operationId: 'decideReleaseQualification',
    description:
      'Record a decision by the assigned reviewer with live workspace authority, or REOPEN a withdrawn release as a new unqualified facts revision with unknown rollout. Reopening preserves the saved facts and does not grant edit permission. API keys and service principals cannot decide or reopen.',
    bodyName: 'DecideQualificationRequest',
    outputName: 'QualificationCommandResult',
    tag: 'Workspace',
    responses: {
      '200': 'Original decision on retry.',
      '201': 'Human decision recorded or withdrawn release reopened for facts review.',
      '400': 'Invalid decision or missing command key.',
      '409': 'Facts changed, required facts are missing, or the revision already has a decision.',
    },
  }),
  method: 'POST',
  name: 'releases.qualification.decide',
  path: '/api/v1/releases/{id}/qualification/decisions',
  output: qualificationResultSchema,
  status: 201,
  summary: 'Record a human release qualification decision',
})

/** Read immutable grouping history without requiring readiness writes to be enabled. */
export const getReleaseLineageContract = defineContract({
  access: { apiKeyScope: 'artifact:read', permission: 'artifact:read' },
  docs: workspaceDocs({
    operationId: 'getReleaseLineage',
    description:
      'Read the human merge and split history for this release, preserving original release and source identities.',
    outputName: 'ReleaseLineageHistory',
    tag: 'Workspace',
    responses: { '200': 'A bounded history page.', '404': 'Release not found in this workspace.' },
  }),
  method: 'GET',
  name: 'releases.qualification.lineage',
  path: '/api/v1/releases/{id}/qualification/lineage',
  params,
  query: z.object({ cursor: params.shape.id.optional() }),
  output: releaseLineageHistorySchema,
  summary: 'Read release merge and split history',
})

/** Human-only grouping keeps the path release as the survivor and retains all history. */
export const mergeReleaseContract = defineContract({
  access: { permission: 'release:create', feature: 'release:create', quota: 'api:write:minute' },
  body: mergeReleaseSchema,
  headers,
  params,
  docs: memberDocs({
    operationId: 'mergeRelease',
    description:
      'Merge active, never-qualified releases using expected revisions and the complete explicit source selection. Preserve old URLs, facts, work and receipts; require facts review afterward. No generation or delivery is dispatched.',
    bodyName: 'MergeReleaseRequest',
    outputName: 'ReleaseLineageResult',
    tag: 'Workspace',
    responses: {
      '200': 'Original grouping result on retry.',
      '201': 'Releases merged and history recorded.',
      '400': 'Invalid participants, selection or command key.',
      '403': 'Human session, current permission or source access required.',
      '409':
        'Revision or source selection changed, release moved, or reviewed work prevents grouping.',
    },
  }),
  method: 'POST',
  name: 'releases.qualification.merge',
  path: '/api/v1/releases/{id}/qualification/merge',
  output: releaseLineageResultSchema,
  status: 201,
  summary: 'Merge unqualified release candidates',
})

/** Human-only source grouping creates unqualified releases and preserves the source release. */
export const splitReleaseContract = defineContract({
  access: { permission: 'release:create', feature: 'release:create', quota: 'api:write:minute' },
  body: splitReleaseSchema,
  headers,
  params,
  docs: memberDocs({
    operationId: 'splitRelease',
    description:
      'Move disjoint, explicit source groups from an active, never-qualified release into new releases with human briefs. Keep existing work and historical evidence on their original release. Every result requires facts review; no generation or delivery is dispatched.',
    bodyName: 'SplitReleaseRequest',
    outputName: 'ReleaseLineageResult',
    tag: 'Workspace',
    responses: {
      '200': 'Original grouping result on retry.',
      '201': 'Releases created and history recorded.',
      '400': 'Invalid groups, briefs or command key.',
      '403': 'Human session, current permission or source access required.',
      '409': 'Revision changed, release moved, or reviewed work prevents grouping.',
    },
  }),
  method: 'POST',
  name: 'releases.qualification.split',
  path: '/api/v1/releases/{id}/qualification/split',
  output: releaseLineageResultSchema,
  status: 201,
  summary: 'Split sources into unqualified release candidates',
})
