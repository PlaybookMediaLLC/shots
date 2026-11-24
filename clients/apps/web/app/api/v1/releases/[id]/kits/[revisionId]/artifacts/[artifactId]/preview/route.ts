import { getKitArtifactPreviewContract } from '@/lib/api/contracts/release-kits'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'
import { watermarkKitPreview } from '@/lib/releases/kit-preview'

/** Return a private, visibly watermarked preview of exact prepared bytes. */
export const GET = route(getKitArtifactPreviewContract, {
  auth: memberAccess(getKitArtifactPreviewContract.access),
  handler: async ({ access, params }) =>
    watermarkKitPreview(
      await backendSDK(access).getKitArtifactPreview(
        params.id,
        params.revisionId,
        params.artifactId
      )
    ),
})
