import type { z } from 'zod'
import { getVoiceSettingsContract } from '@/lib/api/contracts/voice'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** The workspace's voice switches and the member's choices; route() validates the answer. */
export const GET = route(getVoiceSettingsContract, {
  auth: memberAccess(getVoiceSettingsContract.access),
  handler: async ({ access }) =>
    (await backendSDK(access).getVoiceSettings()) as z.input<
      typeof getVoiceSettingsContract.output
    >,
})
