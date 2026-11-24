import { selectReleaseSourcesContract } from '@/lib/api/contracts/release-sources'
import { route } from '@/lib/api/route'
import { tenantAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Select exact evidence, preserving the request body and key on retry. */
export const POST = route(selectReleaseSourcesContract, {
  auth: tenantAccess(selectReleaseSourcesContract.access),
  handler: ({ access, headers, body }) =>
    backendSDK(access).selectReleaseSources(headers['idempotency-key'], body),
  status: (result) => (result.created ? 201 : 200),
})
