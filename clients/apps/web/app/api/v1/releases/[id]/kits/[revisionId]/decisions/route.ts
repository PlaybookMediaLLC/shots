import { decideReleaseKitContract } from '@/lib/api/contracts/release-kits'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Record a human kit review through the tenant-scoped Go domain. */
export const POST = route(decideReleaseKitContract, {
  auth: memberAccess(decideReleaseKitContract.access),
  handler: ({ access, params, headers, body }) =>
    backendSDK(access).decideReleaseKit(
      params.id,
      params.revisionId,
      headers['idempotency-key'],
      body
    ),
  status: (result) => (result.created ? 201 : 200),
})
