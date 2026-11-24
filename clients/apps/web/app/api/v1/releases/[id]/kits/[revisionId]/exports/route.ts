import { requestKitExportContract } from '@/lib/api/contracts/release-kits'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Request an approved ZIP export through the tenant-scoped Go domain. */
export const POST = route(requestKitExportContract, {
  auth: memberAccess(requestKitExportContract.access),
  handler: ({ access, params, headers, body }) =>
    backendSDK(access).requestKitExport(
      params.id,
      params.revisionId,
      headers['idempotency-key'],
      body
    ),
  status: (result) => (result.created ? 202 : 200),
})
