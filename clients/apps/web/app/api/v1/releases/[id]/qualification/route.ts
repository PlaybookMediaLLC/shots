import { getReleaseQualificationContract } from '@/lib/api/contracts/release-readiness'
import { route } from '@/lib/api/route'
import { tenantAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Read the current factual revision and its effective qualification state. */
export const GET = route(getReleaseQualificationContract, {
  auth: tenantAccess(getReleaseQualificationContract.access),
  handler: ({ access, params }) => backendSDK(access).getReleaseQualification(params.id),
})
