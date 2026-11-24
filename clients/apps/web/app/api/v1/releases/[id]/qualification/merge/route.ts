import { mergeReleaseContract } from '@/lib/api/contracts/release-readiness'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Record a human merge without generating, approving or delivering content. */
export const POST = route(mergeReleaseContract, {
  auth: memberAccess(mergeReleaseContract.access),
  handler: ({ access, params, headers, body }) =>
    backendSDK(access).mergeRelease(params.id, headers['idempotency-key'], body),
  status: (result) => (result.created ? 201 : 200),
})
