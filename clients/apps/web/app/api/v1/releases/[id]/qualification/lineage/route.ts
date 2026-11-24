import { getReleaseLineageContract } from '@/lib/api/contracts/release-readiness'
import { route } from '@/lib/api/route'
import { tenantAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Read recorded release grouping changes, including merged release history. */
export const GET = route(getReleaseLineageContract, {
  auth: tenantAccess(getReleaseLineageContract.access),
  handler: ({ access, params, query }) =>
    backendSDK(access).getReleaseLineage(params.id, query.cursor),
})
