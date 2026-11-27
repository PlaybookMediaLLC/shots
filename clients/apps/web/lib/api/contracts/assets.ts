import { z } from 'zod'
import { defineContract, mirrors } from '@/lib/api/contract'
import { workspaceDocs } from '@/lib/api/contracts/workspace-docs'
import type { AssetDeletionResult, completeAssetUpload, signAssetUpload } from '@/lib/tenant/assets'
import {
  assetCompleteSchema,
  assetDownloadQuerySchema,
  assetUploadSchema,
} from '@/lib/tenant/schemas'

/** Upload states of an asset. */
export const assetStatusSchema = z.enum(['PENDING', 'UPLOADED', 'FAILED', 'DELETED'])

/** An asset record. */
export const assetSchema = z.object({
  id: z.string(),
  objectKey: z.string(),
  status: assetStatusSchema,
})

/** Outcomes of an asset deletion request. */
export const assetDeletionResultSchema = mirrors<AssetDeletionResult>()(
  z.enum(['deleted', 'in-use', 'not-found', 'not-ready'])
)

/** The `{assetId}` path parameter. */
export const assetParamsSchema = assetDownloadQuerySchema

const assetNotFound = 'The asset was not found in this workspace.'

/** `POST /api/v1/assets/upload-url` (also served under `/api/tenant/assets`). */
export const createAssetUploadUrlContract = defineContract({
  access: {
    apiKeyScope: 'upload:sign',
    feature: 'asset:create',
    permission: 'artifact:edit',
    quota: 'api:write:minute',
  },
  body: assetUploadSchema,
  docs: workspaceDocs({
    bodyName: 'AssetUploadRequest',
    description:
      'Creates an asset record and a short-lived signed upload URL. Upload the bytes with `PUT`, the declared `Content-Type`, and `If-None-Match: *`: the URL is write-once and both headers are part of its signature. Requires the `upload:sign` scope.',
    operationId: 'createAssetUploadUrl',
    responses: { '201': 'Signed upload instructions.', '400': 'The asset metadata is invalid.' },
    tag: 'Assets',
  }),
  method: 'POST',
  name: 'assets.upload-url',
  output: mirrors<Awaited<ReturnType<typeof signAssetUpload>>>()(
    z.object({ asset: assetSchema, uploadUrl: z.string() })
  ),
  path: '/api/v1/assets/upload-url',
  status: 201,
  summary: 'Create a signed asset upload URL',
})

/** `POST /api/v1/assets/{assetId}/complete` */
export const completeAssetUploadContract = defineContract({
  access: { apiKeyScope: 'asset:write', permission: 'artifact:edit', quota: 'api:write:minute' },
  body: assetCompleteSchema.omit({ assetId: true }),
  docs: workspaceDocs({
    bodyName: 'AssetCompleteRequest',
    description:
      'Marks a signed upload as complete after storage verification. Requires the `asset:write` scope.',
    operationId: 'completeAssetUpload',
    responses: {
      '200': 'Asset upload completed.',
      '400': 'The completion input is invalid.',
      '404': assetNotFound,
    },
    tag: 'Assets',
  }),
  method: 'POST',
  name: 'assets.complete',
  output: z.object({
    asset: mirrors<NonNullable<Awaited<ReturnType<typeof completeAssetUpload>>>>()(assetSchema),
  }),
  params: assetParamsSchema,
  path: '/api/v1/assets/{assetId}/complete',
  summary: 'Complete an asset upload',
})

/** `GET /api/v1/assets/{assetId}/download-url` */
export const createAssetDownloadUrlContract = defineContract({
  access: { apiKeyScope: 'artifact:read', permission: 'artifact:read' },
  docs: workspaceDocs({
    description:
      'Returns a download URL valid for up to two minutes. Each download rechecks the issuing session or credential and current asset access; revocation invalidates outstanding links. Requires the `artifact:read` scope.',
    operationId: 'createAssetDownloadUrl',
    outputName: 'AssetDownloadResponse',
    responses: {
      '200': 'Signed asset download URL.',
      '400': 'The asset identifier is invalid.',
      '404': assetNotFound,
    },
    tag: 'Assets',
  }),
  method: 'GET',
  name: 'assets.download-url',
  output: z.object({ downloadUrl: z.url() }),
  params: assetParamsSchema,
  path: '/api/v1/assets/{assetId}/download-url',
  summary: 'Create a signed asset download URL',
})

/**
 * `GET /api/v1/assets/{assetId}/content`: reads through current authorization.
 * Documents embed this stable address; optional encrypted download grants keep
 * the short-lived bearer-link contract while allowing immediate revocation.
 */
export const assetContentContract = defineContract({
  method: 'GET',
  headers: z.object({
    'if-none-match': z.string().max(256).optional(),
    range: z.string().max(256).optional(),
  }),
  name: 'assets.content',
  query: z.object({
    downloadToken: z.string().min(1).max(4096).optional(),
    variant: z.enum(['original', 'thumbnail']).default('original'),
  }),
  output: z.never(),
  params: assetParamsSchema,
  path: '/api/v1/assets/{assetId}/content',
  summary: 'Read a workspace asset',
})

/** `DELETE /api/v1/assets/{assetId}` */
export const deleteAssetContract = defineContract({
  access: {
    apiKeyScope: 'asset:write',
    feature: 'asset:delete',
    permission: 'artifact:edit',
    quota: 'api:write:minute',
  },
  docs: workspaceDocs({
    description:
      'Queues deletion of an uploaded asset that is not in use. Requires the `asset:write` scope and the asset deletion workspace entitlement (Pro or higher by default).',
    operationId: 'deleteAsset',
    responses: {
      '202': 'Asset deletion accepted.',
      '400': 'The asset identifier is invalid.',
      '403':
        'The principal lacks the required workspace permission, scope, or pricing entitlement.',
      '404': assetNotFound,
      '409': 'The asset is in use or is not ready for deletion.',
      '429': 'The workspace plan quota has been exceeded.',
    },
    tag: 'Assets',
  }),
  method: 'DELETE',
  name: 'assets.delete',
  output: z.object({ accepted: z.literal(true) }),
  params: assetParamsSchema,
  path: '/api/v1/assets/{assetId}',
  status: 202,
  summary: 'Delete a workspace asset',
})

/** An image's description, posted with it as alt text (RFC 025). */
export const assetAltTextSchema = z.object({
  altText: z.string().nullable(),
  id: z.string(),
})

/** `POST /api/v1/assets/{assetId}/describe`; suggestions require explicit saving. */
export const describeAssetContract = defineContract({
  method: 'POST',
  name: 'assets.describe',
  params: assetParamsSchema,
  output: z.object({ altText: z.string().min(1).max(1000) }),
  path: '/api/v1/assets/{assetId}/describe',
  summary: 'Suggest an image description using workspace AI credits',
})

/** `PUT /api/v1/assets/{assetId}/alt-text` */
export const setAssetAltTextContract = defineContract({
  access: {
    apiKeyScope: 'asset:write',
    feature: 'content:drafts',
    permission: 'artifact:edit',
    quota: 'api:write:minute',
  },
  body: z.strictObject({ altText: z.string().max(1_000) }),
  docs: workspaceDocs({
    description:
      'Describes an uploaded image for people who cannot see it. The description is posted with the image wherever it goes (X takes up to 1,000 characters, LinkedIn more); an empty string clears it.',
    operationId: 'setAssetAltText',
    outputName: 'AssetAltText',
    responses: {
      '200': 'The image and its description.',
      '400': 'The description is too long, or the asset is not an image.',
      '404': assetNotFound,
    },
    tag: 'Assets',
  }),
  method: 'PUT',
  name: 'assets.alt-text',
  output: assetAltTextSchema,
  params: assetParamsSchema,
  path: '/api/v1/assets/{assetId}/alt-text',
  summary: "Set an image's alt text",
})
