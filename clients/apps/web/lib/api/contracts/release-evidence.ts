import { z } from 'zod'
import {
  readinessCommandKeySchema,
  readinessMutationSchema,
  createReleaseEvidenceSchema,
  linkReleaseEvidenceSchema,
  changeEvidenceAccessSchema,
  saveReleaseClaimSchema,
  setClaimSupportsSchema,
  verifyReleaseClaimSchema,
  importReleaseSpecClaimsSchema,
  releaseEvidencePageSchema,
  releaseClaimsPageSchema,
} from 'screenshot-studio-backend-sdk'
import { defineContract } from '@/lib/api/contract'
import { memberDocs, workspaceDocs } from '@/lib/api/contracts/workspace-docs'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const params = z.object({ id })
const headers = z.object({ 'idempotency-key': readinessCommandKeySchema })

/** Retain evidence for a release */
export const createReleaseEvidenceContract = defineContract({
  access: { permission: 'release:create', feature: 'release:create', quota: 'api:write:minute' },
  body: createReleaseEvidenceSchema,
  headers,
  params: params,
  docs: memberDocs({
    operationId: 'createReleaseEvidence',
    description:
      'Save bounded text, an accountable attestation, an owned image, or a retained provider snapshot.',
    bodyName: 'CreateReleaseEvidenceRequest',
    outputName: 'ReadinessMutation',
    tag: 'Workspace',
    responses: {
      '200': 'Original result on retry.',
      '201': 'Immutable revision or decision recorded.',
      '400': 'Invalid input.',
      '403': 'Human authority required.',
      '409': 'Revision or evidence changed; reload before deciding.',
    },
  }),
  method: 'POST',
  name: 'releases.create-release-evidence',
  path: '/api/v1/releases/{id}/evidence',
  output: readinessMutationSchema,
  status: 201,
  summary: 'Retain evidence for a release',
})

/** Attach an existing evidence snapshot */
export const linkReleaseEvidenceContract = defineContract({
  access: { permission: 'release:create', feature: 'release:create', quota: 'api:write:minute' },
  body: linkReleaseEvidenceSchema,
  headers,
  params: params,
  docs: memberDocs({
    operationId: 'linkReleaseEvidence',
    description: 'Bind an exact workspace snapshot to a release without copying its bytes.',
    bodyName: 'LinkReleaseEvidenceRequest',
    outputName: 'ReadinessMutation',
    tag: 'Workspace',
    responses: {
      '200': 'Original result on retry.',
      '201': 'Immutable revision or decision recorded.',
      '400': 'Invalid input.',
      '403': 'Human authority required.',
      '409': 'Revision or evidence changed; reload before deciding.',
    },
  }),
  method: 'POST',
  name: 'releases.link-release-evidence',
  path: '/api/v1/releases/{id}/evidence/links',
  output: readinessMutationSchema,
  status: 201,
  summary: 'Attach an existing evidence snapshot',
})

/** Change evidence access or retention */
export const changeEvidenceAccessContract = defineContract({
  access: { permission: 'artifact:read', feature: 'release:create', quota: 'api:write:minute' },
  body: changeEvidenceAccessSchema,
  headers,
  params: params,
  docs: memberDocs({
    operationId: 'changeEvidenceAccess',
    description:
      'Go checks action-specific authority: assigned approvers clear audiences; editors withdraw or erase retained text. Image deletion uses the existing asset endpoint.',
    bodyName: 'ChangeEvidenceAccessRequest',
    outputName: 'ReadinessMutation',
    tag: 'Workspace',
    responses: {
      '200': 'Original result on retry.',
      '201': 'Immutable revision or decision recorded.',
      '400': 'Invalid input.',
      '403': 'Human authority required.',
      '409': 'Revision or evidence changed; reload before deciding.',
    },
  }),
  method: 'POST',
  name: 'releases.change-evidence-access',
  path: '/api/v1/releases/{id}/evidence/access',
  output: readinessMutationSchema,
  status: 201,
  summary: 'Change evidence access or retention',
})

/** Save a stable release claim */
export const saveReleaseClaimContract = defineContract({
  access: { permission: 'release:create', feature: 'release:create', quota: 'api:write:minute' },
  body: saveReleaseClaimSchema,
  headers,
  params: params,
  docs: memberDocs({
    operationId: 'saveReleaseClaim',
    description:
      'Append exact claim text and qualifiers as an unresolved version. Unrelated claims retain their decisions.',
    bodyName: 'SaveReleaseClaimRequest',
    outputName: 'ReadinessMutation',
    tag: 'Workspace',
    responses: {
      '200': 'Original result on retry.',
      '201': 'Immutable revision or decision recorded.',
      '400': 'Invalid input.',
      '403': 'Human authority required.',
      '409': 'Revision or evidence changed; reload before deciding.',
    },
  }),
  method: 'POST',
  name: 'releases.save-release-claim',
  path: '/api/v1/releases/{id}/claims',
  output: readinessMutationSchema,
  status: 201,
  summary: 'Save a stable release claim',
})

/** Replace a claim support set */
export const setClaimSupportsContract = defineContract({
  access: { permission: 'release:create', feature: 'release:create', quota: 'api:write:minute' },
  body: setClaimSupportsSchema,
  headers,
  params: params.extend({ claimId: id }),
  docs: memberDocs({
    operationId: 'setClaimSupports',
    description:
      'Pin exact evidence versions and byte or pixel selectors, retaining contradictory passages or explicit exclusions.',
    bodyName: 'SetClaimSupportsRequest',
    outputName: 'ReadinessMutation',
    tag: 'Workspace',
    responses: {
      '200': 'Original result on retry.',
      '201': 'Immutable revision or decision recorded.',
      '400': 'Invalid input.',
      '403': 'Human authority required.',
      '409': 'Revision or evidence changed; reload before deciding.',
    },
  }),
  method: 'POST',
  name: 'releases.set-claim-supports',
  path: '/api/v1/releases/{id}/claims/{claimId}/support',
  output: readinessMutationSchema,
  status: 201,
  summary: 'Replace a claim support set',
})

/** Record a human factual decision */
export const verifyReleaseClaimContract = defineContract({
  access: { permission: 'release:approve', feature: 'release:create', quota: 'api:write:minute' },
  body: verifyReleaseClaimSchema,
  headers,
  params: params.extend({ claimId: id }),
  docs: memberDocs({
    operationId: 'verifyReleaseClaim',
    description:
      'Require the assigned human reviewer, exact current claim and support hashes, live evidence and a rationale.',
    bodyName: 'VerifyReleaseClaimRequest',
    outputName: 'ReadinessMutation',
    tag: 'Workspace',
    responses: {
      '200': 'Original result on retry.',
      '201': 'Immutable revision or decision recorded.',
      '400': 'Invalid input.',
      '403': 'Human authority required.',
      '409': 'Revision or evidence changed; reload before deciding.',
    },
  }),
  method: 'POST',
  name: 'releases.verify-release-claim',
  path: '/api/v1/releases/{id}/claims/{claimId}/decisions',
  output: readinessMutationSchema,
  status: 201,
  summary: 'Record a human factual decision',
})

/** Import historical claims for review */
export const importReleaseSpecClaimsContract = defineContract({
  access: { permission: 'release:create', feature: 'release:create', quota: 'api:write:minute' },
  body: importReleaseSpecClaimsSchema,
  headers,
  params: params,
  docs: memberDocs({
    operationId: 'importReleaseSpecClaims',
    description:
      'Preserve historical spec approvals and create unverified stable claim mappings. Source labels remain scoped to their original spec.',
    bodyName: 'ImportReleaseSpecClaimsRequest',
    outputName: 'ReadinessMutation',
    tag: 'Workspace',
    responses: {
      '200': 'Original result on retry.',
      '201': 'Immutable revision or decision recorded.',
      '400': 'Invalid input.',
      '403': 'Human authority required.',
      '409': 'Revision or evidence changed; reload before deciding.',
    },
  }),
  method: 'POST',
  name: 'releases.import-release-spec-claims',
  path: '/api/v1/releases/{id}/claims/imports',
  output: readinessMutationSchema,
  status: 201,
  summary: 'Import historical claims for review',
})

/** List release evidence */
export const listReleaseEvidenceContract = defineContract({
  access: { permission: 'artifact:read', apiKeyScope: 'artifact:read' },
  params,
  query: z.object({ cursor: z.string().max(1024).optional() }),
  docs: workspaceDocs({
    operationId: 'listReleaseEvidence',
    description:
      'Read bounded retained snapshots. Unavailable and erased sources return metadata; machine reads omit private excerpts.',
    outputName: 'ListReleaseEvidencePage',
    tag: 'Workspace',
    responses: { '200': 'Bounded current records.', '404': 'Release not found.' },
  }),
  method: 'GET',
  name: 'releases.list-release-evidence',
  path: '/api/v1/releases/{id}/evidence',
  output: releaseEvidencePageSchema,
  summary: 'List release evidence',
})

/** List release claims */
export const listReleaseClaimsContract = defineContract({
  access: { permission: 'artifact:read', apiKeyScope: 'artifact:read' },
  params,
  query: z.object({ cursor: z.string().max(1024).optional() }),
  docs: workspaceDocs({
    operationId: 'listReleaseClaims',
    description:
      'Read current claim versions, exact decisions, permitted supporting excerpts and reasons that require review.',
    outputName: 'ListReleaseClaimsPage',
    tag: 'Workspace',
    responses: { '200': 'Bounded current records.', '404': 'Release not found.' },
  }),
  method: 'GET',
  name: 'releases.list-release-claims',
  path: '/api/v1/releases/{id}/claims',
  output: releaseClaimsPageSchema,
  summary: 'List release claims',
})
