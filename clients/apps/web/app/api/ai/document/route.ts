import { isCampaignStudioConfigured } from '@/lib/ai/agents/campaign-studio'
import { streamDocumentChat } from '@/lib/ai/document/chat'
import { documentChatContract } from '@/lib/api/contracts/ai'
import { errorResponse, route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { isAiEnabled } from '@/lib/trpc/routers/launch'

/** A long answer streams for a while; give it room on serverless hosts. */
export const maxDuration = 120

/** The document editor's AI menu: generate, edit or comment on a draft. */
export const POST = route(documentChatContract, {
  auth: organizationAccess('artifact:edit'),
  handler: async ({ access, body, query }) => {
    if (!isCampaignStudioConfigured()) return errorResponse(503, 'AI is not configured.')
    if (!(await isAiEnabled(access))) {
      return errorResponse(403, 'AI is turned off for this workspace.')
    }
    return streamDocumentChat(access, body, query)
  },
})
