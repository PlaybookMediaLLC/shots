import { prepareReleaseKitContract } from '@/lib/api/contracts/release-kits'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Prepare immutable kit outputs through the tenant-scoped Go domain. */
export const POST = route(prepareReleaseKitContract, {
  auth: memberAccess(prepareReleaseKitContract.access),
  handler: ({ access, params, headers, body }) =>
    backendSDK(access).prepareReleaseKit(
      params.id,
      params.revisionId,
      headers['idempotency-key'],
      body
    ),
  status: (result) => (result.created ? 202 : 200),
})
