import type { z } from 'zod'
import { redactVoiceTranscriptContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Clear a revision's text and segments; the backend audits it. */
export const POST = route(redactVoiceTranscriptContract, {
  auth: memberAccess(redactVoiceTranscriptContract.access),
  handler: async ({ access, params }) =>
    (await backendSDK(access).redactVoiceTranscript(params.id, params.revisionId)) as z.input<
      typeof redactVoiceTranscriptContract.output
    >,
})
