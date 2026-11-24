import { linkReleaseEvidenceContract } from '@/lib/api/contracts/release-evidence'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Link an existing workspace evidence snapshot to this release. */
export const POST = route(linkReleaseEvidenceContract, {
  auth: memberAccess(linkReleaseEvidenceContract.access),
  handler: ({ access, params, headers, body }) =>
    backendSDK(access).linkReleaseEvidence(params.id, headers['idempotency-key'], body),
  status: (result) => (result.created ? 201 : 200),
})
