import type { z } from 'zod'
import { updateVoiceMemberSettingsContract } from '@/lib/api/contracts/voice'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Record the member's consent and voice command choice; commands need the consent. */
export const PUT = route(updateVoiceMemberSettingsContract, {
  auth: memberAccess(updateVoiceMemberSettingsContract.access),
  handler: async ({ access, body }) =>
    (await backendSDK(access).updateVoiceMemberSettings(body)) as z.input<
      typeof updateVoiceMemberSettingsContract.output
    >,
})
