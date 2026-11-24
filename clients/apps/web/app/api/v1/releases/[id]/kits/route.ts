import { getReleaseKitContract } from '@/lib/api/contracts/release-kits'
import { tenantAccess } from '@/lib/api/route-auth'
import { createReleaseKitRevisionContract } from '@/lib/api/contracts/release-kits'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Assemble or replace a release kit through the tenant-scoped Go domain. */
export const POST = route(createReleaseKitRevisionContract, {
  auth: memberAccess(createReleaseKitRevisionContract.access),
  handler: ({ access, params, headers, body }) =>
    backendSDK(access).createReleaseKitRevision(params.id, headers['idempotency-key'], body),
  status: (result) => (result.created ? 201 : 200),
})

/** Read current or historical kit readiness with private machine fields redacted. */
export const GET = route(getReleaseKitContract, {
  auth: tenantAccess(getReleaseKitContract.access),
  handler: ({ access, params, query }) =>
    backendSDK(access).getReleaseKit(params.id, query.revisionId),
})
