import { setClaimSupportsContract } from '@/lib/api/contracts/release-evidence'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Replace the review support set with pinned passages or image regions. */
export const POST = route(setClaimSupportsContract, {
  auth: memberAccess(setClaimSupportsContract.access),
  handler: ({ access, params, headers, body }) =>
    backendSDK(access).setClaimSupports(
      params.id,
      params.claimId,
      headers['idempotency-key'],
      body
    ),
  status: (result) => (result.created ? 201 : 200),
})
