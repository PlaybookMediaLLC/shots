import { getQualificationRevisionContract } from '@/lib/api/contracts/release-readiness'
import { route } from '@/lib/api/route'
import { tenantAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Retrieve historical facts and their decision in the current tenant. */
export const GET = route(getQualificationRevisionContract, {
  auth: tenantAccess(getQualificationRevisionContract.access),
  handler: ({ access, params }) =>
    backendSDK(access).getQualificationRevision(params.id, params.revisionId),
})
