import { getCodeProjectContract } from '@/lib/api/contracts/code-projects'
import { errorResponse, route } from '@/lib/api/route'
import { tenantAccess } from '@/lib/api/route-auth'
import { codeProjectForApi } from '@/lib/tenant/code-projects'

/** Read a code project. */
export const GET = route(getCodeProjectContract, {
  auth: tenantAccess(getCodeProjectContract.access),
  handler: async ({ access, params }) =>
    (await codeProjectForApi(access, params.projectId)) ??
    errorResponse(404, 'Code project not found.'),
})
