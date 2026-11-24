import { createQualificationContract } from '@/lib/api/contracts/release-readiness'
import { route } from '@/lib/api/route'
import { tenantAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Save a versioned facts draft, retaining the original result on retry. */
export const POST = route(createQualificationContract, {
  auth: tenantAccess(createQualificationContract.access),
  handler: ({ access, params, headers, body }) =>
    backendSDK(access).createQualificationRevision(params.id, headers['idempotency-key'], body),
  status: (result) => (result.created ? 201 : 200),
})
