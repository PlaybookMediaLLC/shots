import {
  saveReleaseClaimContract,
  listReleaseClaimsContract,
} from '@/lib/api/contracts/release-evidence'
import { route } from '@/lib/api/route'
import { memberAccess, tenantAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Create an unresolved claim version with explicit rollout and audience qualifiers. */
export const POST = route(saveReleaseClaimContract, {
  auth: memberAccess(saveReleaseClaimContract.access),
  handler: ({ access, params, headers, body }) =>
    backendSDK(access).saveReleaseClaim(params.id, headers['idempotency-key'], body),
  status: (result) => (result.created ? 201 : 200),
})

/** List current claim versions with permissioned evidence and review blockers. */
export const GET = route(listReleaseClaimsContract, {
  auth: tenantAccess(listReleaseClaimsContract.access),
  handler: ({ access, params, query }) =>
    backendSDK(access).listReleaseClaims(params.id, query.cursor),
})
