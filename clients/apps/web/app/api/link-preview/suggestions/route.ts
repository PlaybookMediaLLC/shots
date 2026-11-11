import { suggestLinkCopyContract } from '@/lib/api/contracts/link-preview'
import { LAUNCH_AI_RATE_LIMIT } from '@/lib/api/rate-limit-policy'
import { errorResponse, route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { isCampaignStudioConfigured } from '@/lib/ai/agents/campaign-studio'
import { withAiCredits } from '@/lib/ai/metering'
import { workspaceQuotaSchema } from '@/lib/billing/plans'
import { suggestLinkCopy } from '@/lib/link-preview/suggest'
import { checkRateLimit } from '@/lib/rate-limit'
import { consumeWorkspaceQuota } from '@/lib/tenant/entitlements'
import { isAiEnabled } from '@/lib/trpc/routers/launch'
import { getWorkspaceVoice } from '@/lib/launch/store'

/** The page fetch plus a few model steps. */
export const maxDuration = 60

/**
 * `POST /api/link-preview/suggestions`: three title and description options
 * for a page. Like the launch pipeline's AI actions it checks that AI is
 * configured, rate-limits per workspace, refuses when no AI credits are left,
 * and charges each model call to the workspace's credits.
 */
export const POST = route(suggestLinkCopyContract, {
  auth: organizationAccess('artifact:edit'),
  handler: async ({ access, body }) => {
    if (!isCampaignStudioConfigured()) {
      return errorResponse(503, 'AI is not configured for this workspace.')
    }
    if (!(await isAiEnabled(access))) {
      return errorResponse(403, 'AI is turned off for this workspace.')
    }
    const limit = await checkRateLimit(
      `link-copy-ai:${access.organizationId}`,
      LAUNCH_AI_RATE_LIMIT
    )
    if (!limit.allowed)
      return errorResponse(429, 'Too many AI requests. Wait a minute and try again.')
    await consumeWorkspaceQuota(access, workspaceQuotaSchema.enum['ai:credits:monthly'], 0)
    const voice = await getWorkspaceVoice(access)
    return {
      variants: await withAiCredits(access, () => suggestLinkCopy(body.url, body.agent, voice)),
    }
  },
})
