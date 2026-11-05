import { getSocialConnectionCapacityContract } from '@/lib/api/contracts/social-availability'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Read account capacity through the authenticated Go tenant boundary. */
export const GET = route(getSocialConnectionCapacityContract, {
  auth: memberAccess(getSocialConnectionCapacityContract.access),
  handler: ({ access }) => backendSDK(access).socialConnectionCapacity(),
})
