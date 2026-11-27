import 'server-only'

import { TRPCError } from '@trpc/server'
import {
  completeAssetUpload,
  deleteAsset,
  listAssets,
  signAssetDownload,
  signAssetDownloads,
  signAssetUpload,
  signAssetUploadInParts,
  signAssetUploadParts,
} from '@/lib/tenant/assets'
import {
  assetDownloadQuerySchema,
  assetDownloadsQuerySchema,
  assetListQuerySchema,
  assetPartsCompleteSchema,
  assetUploadPartsSchema,
  assetUploadSchema,
} from '@/lib/tenant/schemas'
import { router } from '../init'
import { tenantProcedure } from '../procedures'

export const assetRouter = router({
  list: tenantProcedure({ apiKeyScope: 'artifact:read', permission: 'artifact:read' })
    .input(assetListQuerySchema.optional())
    .query(async ({ ctx, input }) =>
      listAssets(ctx.tenant, {
        cursor: input?.cursor,
        search: input?.search,
        classification: input?.classification,
        take: input?.limit ?? 50,
        type: input?.type,
        sort: input?.sort,
      })
    ),
  signUpload: tenantProcedure({ apiKeyScope: 'upload:sign', permission: 'artifact:edit' })
    .input(assetUploadSchema)
    .mutation(async ({ ctx, input }) => signAssetUpload(ctx.tenant, input)),
  /** Reserve a large file to send in parts (docs/tenant-storage.md). */
  signUploadInParts: tenantProcedure({ apiKeyScope: 'upload:sign', permission: 'artifact:edit' })
    .input(assetUploadSchema)
    .mutation(async ({ ctx, input }) => signAssetUploadInParts(ctx.tenant, input)),
  /** What a multipart upload holds, and signed PUTs for the parts still to send. */
  uploadParts: tenantProcedure({ apiKeyScope: 'upload:sign', permission: 'artifact:edit' })
    .input(assetUploadPartsSchema)
    .mutation(async ({ ctx, input }) =>
      signAssetUploadParts(ctx.tenant, input.assetId, input.parts)
    ),
  completeUpload: tenantProcedure({ apiKeyScope: 'asset:write', permission: 'artifact:edit' })
    .input(assetPartsCompleteSchema)
    .mutation(async ({ ctx, input }) => {
      const asset = await completeAssetUpload(
        ctx.tenant,
        input.assetId,
        input.sha256,
        input.partSha256
      )
      if (!asset) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Asset not found.' })
      }
      return { asset }
    }),
  signDownload: tenantProcedure({ apiKeyScope: 'artifact:read', permission: 'artifact:read' })
    .input(assetDownloadQuerySchema)
    .query(async ({ ctx, input }) => {
      const downloadUrl = await signAssetDownload(ctx.tenant, input.assetId)
      if (!downloadUrl) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Asset not found.' })
      }
      return { downloadUrl }
    }),
  signDownloads: tenantProcedure({ apiKeyScope: 'artifact:read', permission: 'artifact:read' })
    .input(assetDownloadsQuerySchema)
    .query(async ({ ctx, input }) => ({
      urls: await signAssetDownloads(ctx.tenant, input.assetIds),
    })),
  delete: tenantProcedure({
    apiKeyScope: 'asset:write',
    permission: 'artifact:edit',
    quota: 'api:write:minute',
  })
    .input(assetDownloadQuerySchema)
    .mutation(async ({ ctx, input }) => {
      const result = await deleteAsset(ctx.tenant, input.assetId)
      if (result === 'not-found') {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Asset not found.' })
      }
      if (result === 'in-use') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Asset is in use by a creative variant.',
        })
      }
      if (result === 'not-ready') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Only uploaded assets can be deleted.',
        })
      }
      return { accepted: true as const }
    }),
})
