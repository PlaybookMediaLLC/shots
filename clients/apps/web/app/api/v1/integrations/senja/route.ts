import {
  removeSenjaKeyContract,
  saveSenjaKeyContract,
  senjaStatusContract,
} from '@/lib/api/contracts/senja'
import { errorResponse, route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import {
  removeSenjaKey,
  saveSenjaKey,
  senjaConfigured,
  SenjaError,
} from '@/lib/content-drafts/senja'
import { canSealCredentials } from '@/lib/integrations/crypto'

/** Whether Senja import is set up; any member may read it, never the key. */
export const GET = route(senjaStatusContract, {
  auth: organizationAccess('artifact:read'),
  handler: async ({ access }) => ({
    configured: await senjaConfigured(access),
    sealable: canSealCredentials(),
  }),
})

/** An admin's Senja key, checked with Senja before it is sealed and saved. */
export const PUT = route(saveSenjaKeyContract, {
  auth: organizationAccess('workspace:update'),
  handler: async ({ access, body }) => {
    if (!canSealCredentials())
      return errorResponse(
        503,
        'Senja keys cannot be saved on this deployment until INTEGRATION_ENCRYPTION_KEY is set.'
      )
    try {
      await saveSenjaKey(access, body.apiKey)
    } catch (error) {
      if (error instanceof SenjaError) return errorResponse(error.status, error.message)
      throw error
    }
    return { configured: true, sealable: true }
  },
})

/** Forget the workspace's Senja key; imported videos stay. */
export const DELETE = route(removeSenjaKeyContract, {
  auth: organizationAccess('workspace:update'),
  handler: async ({ access }) => {
    await removeSenjaKey(access)
    return { configured: false, sealable: canSealCredentials() }
  },
})
