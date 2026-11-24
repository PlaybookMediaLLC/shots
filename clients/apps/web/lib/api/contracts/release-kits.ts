import { z } from 'zod'
import {
  readinessCommandKeySchema,
  readinessMutationSchema,
  createReleaseKitSchema,
  prepareReleaseKitSchema,
  decideReleaseKitSchema,
  requestKitExportSchema,
  releaseKitSchema,
  kitExportSchema,
  kitPreviewSchema,
} from 'screenshot-studio-backend-sdk'
import { defineContract } from '@/lib/api/contract'
import { memberDocs, workspaceDocs } from '@/lib/api/contracts/workspace-docs'
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const headers = z.object({ 'idempotency-key': readinessCommandKeySchema })

/** Assemble or replace a release kit; all decisions and writes require a current human session. */
export const createReleaseKitRevisionContract = defineContract({
  access: { permission: 'release:create', feature: 'release:create', quota: 'api:write:minute' },
  body: createReleaseKitSchema,
  headers,
  params: z.object({ id }),
  docs: memberDocs({
    operationId: 'createReleaseKitRevision',
    description:
      'Assemble or replace a release kit. The Go domain checks the aggregate revision, exact dependencies and current authority.',
    bodyName: 'CreateReleaseKitRevisionRequest',
    outputName: 'ReadinessMutation',
    tag: 'Workspace',
    responses: {
      '200': 'Original result on retry.',
      '201': 'Request recorded.',
      '403': 'Human authority required.',
      '409': 'Current readiness or revision blocks this action.',
    },
  }),
  method: 'POST',
  name: 'releases.create-release-kit-revision',
  path: '/api/v1/releases/{id}/kits',
  output: readinessMutationSchema,
  status: 201,
  summary: 'Assemble or replace a release kit',
})

/** Prepare immutable kit outputs; all decisions and writes require a current human session. */
export const prepareReleaseKitContract = defineContract({
  access: { permission: 'release:create', feature: 'release:create', quota: 'api:write:minute' },
  body: prepareReleaseKitSchema,
  headers,
  params: z.object({ id, revisionId: id }),
  docs: memberDocs({
    operationId: 'prepareReleaseKit',
    description:
      'Prepare immutable kit outputs. The Go domain checks the aggregate revision, exact dependencies and current authority.',
    bodyName: 'PrepareReleaseKitRequest',
    outputName: 'ReadinessMutation',
    tag: 'Workspace',
    responses: {
      '200': 'Original result on retry.',
      '202': 'Request recorded.',
      '403': 'Human authority required.',
      '409': 'Current readiness or revision blocks this action.',
    },
  }),
  method: 'POST',
  name: 'releases.prepare-release-kit',
  path: '/api/v1/releases/{id}/kits/{revisionId}/prepare',
  output: readinessMutationSchema,
  status: 202,
  summary: 'Prepare immutable kit outputs',
})

/** Record a human kit review; all decisions and writes require a current human session. */
export const decideReleaseKitContract = defineContract({
  access: { permission: 'release:approve', feature: 'release:create', quota: 'api:write:minute' },
  body: decideReleaseKitSchema,
  headers,
  params: z.object({ id, revisionId: id }),
  docs: memberDocs({
    operationId: 'decideReleaseKit',
    description:
      'Record a human kit review. The Go domain checks the aggregate revision, exact dependencies and current authority.',
    bodyName: 'DecideReleaseKitRequest',
    outputName: 'ReadinessMutation',
    tag: 'Workspace',
    responses: {
      '200': 'Original result on retry.',
      '201': 'Request recorded.',
      '403': 'Human authority required.',
      '409': 'Current readiness or revision blocks this action.',
    },
  }),
  method: 'POST',
  name: 'releases.decide-release-kit',
  path: '/api/v1/releases/{id}/kits/{revisionId}/decisions',
  output: readinessMutationSchema,
  status: 201,
  summary: 'Record a human kit review',
})

/** Request an approved ZIP export; all decisions and writes require a current human session. */
export const requestKitExportContract = defineContract({
  access: { permission: 'artifact:read', feature: 'release:create', quota: 'api:write:minute' },
  body: requestKitExportSchema,
  headers,
  params: z.object({ id, revisionId: id }),
  docs: memberDocs({
    operationId: 'requestKitExport',
    description:
      'Request an approved ZIP export. The Go domain checks the aggregate revision, exact dependencies and current authority.',
    bodyName: 'RequestKitExportRequest',
    outputName: 'ReadinessMutation',
    tag: 'Workspace',
    responses: {
      '200': 'Original result on retry.',
      '202': 'Request recorded.',
      '403': 'Human authority required.',
      '409': 'Current readiness or revision blocks this action.',
    },
  }),
  method: 'POST',
  name: 'releases.request-kit-export',
  path: '/api/v1/releases/{id}/kits/{revisionId}/exports',
  output: readinessMutationSchema,
  status: 202,
  summary: 'Request an approved ZIP export',
})

/** Read current or historical kit readiness without minting delivery authority. */
export const getReleaseKitContract = defineContract({
  access: { permission: 'artifact:read', apiKeyScope: 'artifact:read' },
  params: z.object({ id }),
  query: z.object({ revisionId: id.optional() }),
  docs: workspaceDocs({
    operationId: 'getReleaseKit',
    description:
      'Read a kit revision, human review history and deterministic current blockers. Machine responses omit native content and private lineage.',
    outputName: 'ReleaseKit',
    tag: 'Workspace',
    responses: { '200': 'Kit revision and current readiness.', '404': 'Kit not found.' },
  }),
  method: 'GET',
  name: 'releases.get-kit',
  path: '/api/v1/releases/{id}/kits',
  output: releaseKitSchema,
  summary: 'Read release kit readiness',
})
/** Read export progress or request a fresh download check for approved bytes. */
export const getKitExportContract = defineContract({
  access: { permission: 'artifact:read', apiKeyScope: 'artifact:read' },
  params: z.object({ id, exportId: id }),
  query: z.object({ download: z.enum(['true', 'false']).default('false') }),
  docs: workspaceDocs({
    operationId: 'getKitExport',
    description:
      'Read persisted export metadata. A download URL requires a new live readiness and authority check; downloaded files cannot be recalled.',
    outputName: 'KitExport',
    tag: 'Workspace',
    responses: {
      '200': 'Export metadata and an optional short-lived URL.',
      '403': 'No current authority.',
      '409': 'Readiness changed.',
    },
  }),
  method: 'GET',
  name: 'releases.get-kit-export',
  path: '/api/v1/releases/{id}/kit-exports/{exportId}',
  output: kitExportSchema,
  summary: 'Read an approved kit export',
})

/** Preview prepared content privately with a watermark, including rejected revisions. */
export const getKitArtifactPreviewContract = defineContract({
  access: { permission: 'artifact:read' },
  params: z.object({ id, revisionId: id, artifactId: id }),
  method: 'GET',
  name: 'release-kits.preview',
  path: '/api/v1/releases/{id}/kits/{revisionId}/artifacts/{artifactId}/preview',
  output: kitPreviewSchema,
  summary: 'Preview a release kit artifact privately',
  docs: memberDocs({
    operationId: 'getKitArtifactPreview',
    description: 'A private watermarked preview grants no export or distribution authority.',
    outputName: 'KitPreview',
    tag: 'Workspace',
    responses: { '200': 'Watermarked preview.', '403': 'Current human membership required.' },
  }),
})
