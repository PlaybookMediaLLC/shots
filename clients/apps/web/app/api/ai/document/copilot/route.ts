import { isCampaignStudioConfigured } from '@/lib/ai/agents/campaign-studio'
import { completeDocumentText } from '@/lib/ai/document/chat'
import { documentCopilotContract } from '@/lib/api/contracts/ai'
import { errorResponse, route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { isAiEnabled } from '@/lib/trpc/routers/launch'

/** Inline ghost-text completion in the document editor. */
export const POST = route(documentCopilotContract, {
  auth: organizationAccess('artifact:edit'),
  handler: async ({ access, body, query }) => {
    if (!isCampaignStudioConfigured()) return errorResponse(503, 'AI is not configured.')
    if (!(await isAiEnabled(access))) {
      return errorResponse(403, 'AI is turned off for this workspace.')
    }
    return completeDocumentText(access, body, query)
  },
})
