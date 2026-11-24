import { decideQualificationContract } from '@/lib/api/contracts/release-readiness'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Record the assigned person's decision without approving or delivering content. */
export const POST = route(decideQualificationContract, {
  auth: memberAccess(decideQualificationContract.access),
  handler: ({ access, params, headers, body }) =>
    backendSDK(access).decideReleaseQualification(params.id, headers['idempotency-key'], body),
  status: (result) => (result.created ? 201 : 200),
})
