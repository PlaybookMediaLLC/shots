import { getKitExportContract } from '@/lib/api/contracts/release-kits'
import { route } from '@/lib/api/route'
import { tenantAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Authorize a fresh download of stored approved bytes, or read export progress. */
export const GET = route(getKitExportContract, {
  auth: tenantAccess(getKitExportContract.access),
  handler: ({ access, params, query }) =>
    backendSDK(access).getKitExport(params.id, params.exportId, query.download === 'true'),
})
