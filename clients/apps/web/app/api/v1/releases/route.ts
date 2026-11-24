import { randomUUID } from 'node:crypto'
import { createReleaseContract, listReleasesContract } from '@/lib/api/contracts/releases'
import { route } from '@/lib/api/route'
import { tenantAccess } from '@/lib/api/route-auth'
import { createRelease, listReleases } from '@/lib/tenant/releases'

/** The workspace's most recent releases. */
export const GET = route(listReleasesContract, {
  auth: tenantAccess(listReleasesContract.access),
  handler: async ({ access, query }) => ({
    releases: await listReleases(access, query.limit, query.search),
  }),
})

/** Create a release. Replaying an `Idempotency-Key` returns the original with 200. */
export const POST = route(createReleaseContract, {
  auth: tenantAccess(createReleaseContract.access),
  handler: async ({ access, body, headers }) =>
    createRelease(access, { ...body, idempotencyKey: headers['idempotency-key'] || randomUUID() }),
  status: (result) => (result.created ? 201 : 200),
})
