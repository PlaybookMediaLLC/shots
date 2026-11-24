import { listReleaseSourcesContract } from '@/lib/api/contracts/release-sources'
import { route } from '@/lib/api/route'
import { tenantAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Read the source inbox or the sources selected for a release. */
export const GET = route(listReleaseSourcesContract, {
  auth: tenantAccess(listReleaseSourcesContract.access),
  handler: ({ access, query }) => backendSDK(access).listReleaseSources(query),
})
