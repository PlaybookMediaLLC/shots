import { backendSDK } from '@/lib/backend/sdk'
import { connectIntegrationContract } from '@/lib/api/contracts/integrations'
import { errorResponse, route } from '@/lib/api/route'
import { navigationOrganizationAccess } from '@/lib/api/route-auth'
import { redirectUri, startState } from '@/lib/integrations/oauth'
import { authorizeUrl, providerClient } from '@/lib/integrations/providers'
import { PROVIDER_NAMES, providerOfSlug } from '@/lib/integrations/schema'
import { providerSetup } from '@/lib/integrations/server'

/** `GET /api/integrations/{provider}/connect`: an owner or admin starts connecting a provider account. */
export const GET = route(connectIntegrationContract, {
  auth: navigationOrganizationAccess('workspace:update'),
  handler: async ({ access, params, query }) => {
    const provider = providerOfSlug(params.provider)
    if (provider === 'SLACK') {
      if (!(await backendSDK(access).slackSetup()).ready)
        return errorResponse(
          503,
          'Slack is not set up on this server. Missing: backend Slack configuration.'
        )
      const { url } = await backendSDK(access).connectNotificationSlack(query.purpose)
      return new Response(null, { status: 302, headers: { location: url } })
    }
    const setup = (await providerSetup(access))[provider]
    const client = providerClient(provider)
    if (!setup.ready || !client) {
      return errorResponse(
        503,
        `${PROVIDER_NAMES[provider]} is not set up on this server. Missing: ${setup.missing.join(', ')}.`
      )
    }
    const { cookie, state } = startState(params.provider, access.organizationId)
    return new Response(null, {
      headers: {
        location: authorizeUrl(provider, client, redirectUri(params.provider), state),
        'set-cookie': cookie,
      },
      status: 302,
    })
  },
})
