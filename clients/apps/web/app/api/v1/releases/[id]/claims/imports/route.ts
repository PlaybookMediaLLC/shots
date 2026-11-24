import { importReleaseSpecClaimsContract } from '@/lib/api/contracts/release-evidence'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Import historical claims without carrying historical approval into factual review. */
export const POST = route(importReleaseSpecClaimsContract, {
  auth: memberAccess(importReleaseSpecClaimsContract.access),
  handler: ({ access, params, headers, body }) =>
    backendSDK(access).importReleaseSpecClaims(params.id, headers['idempotency-key'], body),
  status: (result) => (result.created ? 201 : 200),
})
