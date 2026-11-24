import { verifyReleaseClaimContract } from '@/lib/api/contracts/release-evidence'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Record the assigned human reviewer's decision against exact claim and support hashes. */
export const POST = route(verifyReleaseClaimContract, {
  auth: memberAccess(verifyReleaseClaimContract.access),
  handler: ({ access, params, headers, body }) =>
    backendSDK(access).verifyReleaseClaim(
      params.id,
      params.claimId,
      headers['idempotency-key'],
      body
    ),
  status: (result) => (result.created ? 201 : 200),
})
