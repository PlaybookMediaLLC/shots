import { createCodeProjectContract } from '@/lib/api/contracts/code-projects'
import { route } from '@/lib/api/route'
import { tenantAccess } from '@/lib/api/route-auth'
import { createCodeProjectFromCode } from '@/lib/tenant/code-projects'

/** Create a Code Studio project from code. */
export const POST = route(createCodeProjectContract, {
  auth: tenantAccess(createCodeProjectContract.access),
  handler: async ({ access, body }) => createCodeProjectFromCode(access, body),
})
