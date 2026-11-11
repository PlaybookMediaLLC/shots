import { z } from 'zod'
import { addVoiceTranscriptContract } from '@/lib/api/contracts/voice-actions'
import { route } from '@/lib/api/route'
import { memberAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'

/** Add a revision once per client revision id: 201 when new, 200 when replayed. */
export const POST = route(addVoiceTranscriptContract, {
  auth: memberAccess(addVoiceTranscriptContract.access),
  handler: async ({ access, body, params }) => {
    const { body: result, created } = await backendSDK(access).addVoiceTranscript(params.id, body)
    const parsed = addVoiceTranscriptContract.output.safeParse(result)
    // A backend answer the contract does not describe is a server fault, not a bad request.
    if (!parsed.success)
      throw new Error(
        `The backend answered an unexpected transcript: ${z.prettifyError(parsed.error)}`
      )
    return Response.json(parsed.data, { status: created ? 201 : 200 })
  },
})
