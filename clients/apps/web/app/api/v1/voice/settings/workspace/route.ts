import type { z } from 'zod'
import { updateVoiceWorkspaceSettingsContract } from '@/lib/api/contracts/voice'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Turn voice features on or off for the workspace; owners and admins only. */
export const PUT = route(updateVoiceWorkspaceSettingsContract, {
  auth: memberAccess(updateVoiceWorkspaceSettingsContract.access),
  handler: async ({ access, body }) =>
    (await backendSDK(access).updateVoiceWorkspaceSettings(body)) as z.input<
      typeof updateVoiceWorkspaceSettingsContract.output
    >,
})
