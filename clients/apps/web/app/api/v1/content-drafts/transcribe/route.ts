import { transcribeContract } from '@/lib/api/contracts/write-ai'
import { errorResponse, route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { aiUnavailable, writingContext } from '@/lib/write/ai-route'
import { transcribeVoiceMemo } from '@/lib/write/transcribe'
import { validateVoiceMemo } from '@/lib/write/voice-memo'

/** Metered, workspace-scoped transcription; does not save audio or mutate the draft. */
export const POST = route(transcribeContract, {
  auth: organizationAccess('artifact:edit'),
  handler: async ({ access, body }) => {
    const unavailable = await aiUnavailable(access)
    if (unavailable) return unavailable
    if (
      body.draftId &&
      !(body.channel && (await writingContext(access, body.draftId, body.channel)))
    )
      return errorResponse(404, 'Draft not found.')
    const audio = Buffer.from(body.audio, 'base64')
    try {
      validateVoiceMemo(audio, body.mediaType)
    } catch (error) {
      return errorResponse(422, error instanceof Error ? error.message : 'Invalid audio.')
    }
    return transcribeVoiceMemo(access, audio, body.mediaType)
  },
})
