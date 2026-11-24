import { getReleaseSourceHistoryContract } from '@/lib/api/contracts/release-sources'
import { route } from '@/lib/api/route'
import { tenantAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Read retained observations for one authorized source object. */
export const GET = route(getReleaseSourceHistoryContract, {
  auth: tenantAccess(getReleaseSourceHistoryContract.access),
  handler: ({ access, params, query }) =>
    backendSDK(access).getReleaseSourceHistory(params.id, query.cursor),
})
