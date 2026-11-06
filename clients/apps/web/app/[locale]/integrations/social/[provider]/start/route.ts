import { AuthorizationError } from '@/lib/auth/access'
import {
  isSocialOAuthProvider,
  socialOAuthReturnSchema,
  socialOAuthSignInRedirect,
} from '@/lib/tenant/social-oauth-callback'
import { socialOAuthErrorResponse, startSocialOAuth } from '@/lib/tenant/social-oauth-start'
import { headersWithNavigationScope } from '@/lib/auth/request-scope'

type Context = { params: Promise<{ provider: string }> }

export async function GET(request: Request, context: Context): Promise<Response> {
  const { provider } = await context.params
  if (!isSocialOAuthProvider(provider)) {
    return new Response('Provider not found.', { status: 404 })
  }
  const query = new URL(request.url).searchParams
  const socialSet = query.get('socialSet')
  const back = socialOAuthReturnSchema.safeParse(query.get('returnTo'))
  const socialSetId = socialSet && /^[a-z0-9]{10,32}$/.test(socialSet) ? socialSet : undefined
  try {
    const returnTo = back.success
      ? back.data
      : socialSetId
        ? `/settings/publishing-brands/${socialSetId}`
        : ''
    const expectedConnectionId = query.get('reconnect') || undefined
    const destination = await startSocialOAuth(headersWithNavigationScope(request), provider, socialSetId, {
      expectedConnectionId,
      ...(returnTo ? { returnPath: returnTo } : {}),
    })
    const headers = new Headers({ 'Cache-Control': 'no-store', Location: destination })
    return new Response(null, { headers, status: 303 })
  } catch (error) {
    if (error instanceof AuthorizationError && error.status === 401)
      return socialOAuthSignInRedirect(request.url)
    return socialOAuthErrorResponse(error)
  }
}
