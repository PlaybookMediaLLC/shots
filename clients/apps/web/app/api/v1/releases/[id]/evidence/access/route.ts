import { changeEvidenceAccessContract } from '@/lib/api/contracts/release-evidence'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Record an authorized retention or audience clearance decision. */
export const POST = route(changeEvidenceAccessContract, {
  auth: memberAccess(changeEvidenceAccessContract.access),
  handler: ({ access, params, headers, body }) =>
    backendSDK(access).changeEvidenceAccess(params.id, headers['idempotency-key'], body),
  status: (result) => (result.created ? 201 : 200),
})
