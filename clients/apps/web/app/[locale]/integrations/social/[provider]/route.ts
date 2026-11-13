import {
  completeSocialOAuth,
  isSocialOAuthProvider,
  selectInstagramAccount,
} from '@/lib/tenant/social-oauth-callback'
import {
  exchangeSocialOAuthCallback,
  registerSocialOAuthDestination,
  rememberInstagramIntegration,
  selectInstagramOAuthPage,
  socialOAuthErrorResponse,
} from '@/lib/tenant/social-oauth-start'
import { socialOAuthCompletionRedirect } from '@/lib/tenant/social-oauth-completion'

type Context = { params: Promise<{ provider: string }> }

export async function GET(request: Request, context: Context): Promise<Response> {
  const { provider } = await context.params
  if (!isSocialOAuthProvider(provider)) {
    return new Response('Provider not found.', { status: 404 })
  }
  try {
    return await completeSocialOAuth(request, provider, {
      redirect: async (state) => socialOAuthCompletionRedirect(provider, state),
      exchange: (oauthState, code) =>
        exchangeSocialOAuthCallback(request.headers, provider, oauthState, code),
      onConnected: (oauthState, integrationId) =>
        registerSocialOAuthDestination(request.headers, provider, oauthState, integrationId),
      onPageChoice: (oauthState, integrationId) =>
        rememberInstagramIntegration(request.headers, oauthState, integrationId, provider),
    })
  } catch (error) {
    return socialOAuthErrorResponse(error)
  }
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { provider } = await context.params
  if (
    !isSocialOAuthProvider(provider) ||
    !['instagram', 'linkedin-page', 'youtube', 'facebook', 'gmb'].includes(provider)
  )
    return new Response('Provider not found.', { status: 404 })
  try {
    return await selectInstagramAccount(
      request,
      {
        redirect: async (state) => socialOAuthCompletionRedirect(provider, state),
        selectPage: ({ state, integrationId, accountId, pageId }) =>
          selectInstagramOAuthPage(request.headers, {
            provider,
            state,
            integrationId,
            accountId,
            pageId,
          }),
        onSelected: (state, integrationId) =>
          registerSocialOAuthDestination(request.headers, provider, state, integrationId),
      },
      provider
    )
  } catch (error) {
    return socialOAuthErrorResponse(error)
  }
}
