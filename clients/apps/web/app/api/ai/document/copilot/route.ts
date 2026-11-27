import { isCampaignStudioConfigured } from '@/lib/ai/agents/campaign-studio'
import { handleDocumentCopilotRequest } from '@/lib/ai/document/chat'
import { documentCopilotContract } from '@/lib/api/contracts/ai'
import { route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { checkRateLimit } from '@/lib/rate-limit'
import { isAiEnabled } from '@/lib/trpc/routers/launch'

/** Inline ghost-text completion in the post editor. */
export const POST = route(documentCopilotContract, {
  auth: organizationAccess('artifact:edit'),
  handler: ({ access, body, query, request }) =>
    handleDocumentCopilotRequest(
      { access, body, query, signal: request.signal },
      { checkRateLimit, isAiEnabled, isConfigured: isCampaignStudioConfigured }
    ),
})
