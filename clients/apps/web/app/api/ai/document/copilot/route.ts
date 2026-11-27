import { isCampaignStudioConfigured } from '@/lib/ai/agents/campaign-studio'
import { completeDocumentText } from '@/lib/ai/document/chat'
import { documentCopilotContract } from '@/lib/api/contracts/ai'
import { EDITOR_COPILOT_RATE_LIMIT } from '@/lib/api/rate-limit-policy'
import { errorResponse, route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { isAiEnabled } from '@/lib/trpc/routers/launch'

/** Inline ghost-text completion in the post editor. */
export const POST = route(documentCopilotContract, {
  auth: organizationAccess('artifact:edit'),
  handler: async ({ access, body, query }) => {
    if (!isCampaignStudioConfigured()) return errorResponse(503, 'AI is not configured.')
    const [enabled, limit] = await Promise.all([
      isAiEnabled(access),
      checkRateLimit(`editor-copilot:${access.organizationId}`, EDITOR_COPILOT_RATE_LIMIT),
    ])
    if (!enabled) {
      return errorResponse(403, 'AI is turned off for this workspace.')
    }
    if (!limit.allowed)
      return errorResponse(429, 'Too many AI requests. Wait a minute and try again.')
    return completeDocumentText(access, body, query)
  },
})
