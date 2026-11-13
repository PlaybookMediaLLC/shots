import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { isTrustedRequestOrigin } from '@/lib/security/request-origin'
import {
  socialOAuthProviderSchema,
  socialOAuthExchangeSchema,
  type OAuthProvider,
} from 'screenshot-studio-backend-sdk'

export type SocialOAuthProvider = OAuthProvider

/** Whether the platform has an OAuth adapter for this provider. */
export function isSocialOAuthProvider(provider: string): provider is SocialOAuthProvider {
  return socialOAuthProviderSchema.safeParse(provider).success
}

export type SocialOAuthCompletion = {
  exchange?: (state: string, code: string) => Promise<unknown>
  onConnected?: (state: string, integrationId: string) => Promise<void>
  returnTo?: (state: string) => Promise<string>
  redirect?: (state: string) => Promise<Response>
  onPageChoice?: (state: string, integrationId: string) => Promise<void>
}

export type InstagramSelection = {
  selectPage?: (choice: InstagramChoice) => Promise<void>
  onSelected?: (state: string, integrationId: string) => Promise<void>
  returnTo?: (state: string) => Promise<string>
  redirect?: (state: string) => Promise<Response>
}

const pageChoiceSchema = z.object({
  provider: socialOAuthProviderSchema.default('instagram'),
  accountId: z.string().min(1),
  expiresAt: z.number().int(),
  integrationId: z.string().min(1),
  pageId: z.string().min(1),
  state: z.string().min(1),
})
type InstagramChoice = z.infer<typeof pageChoiceSchema>

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

function pickerSecret(): string | null {
  return process.env.BETTER_AUTH_SECRET || null
}

function signChoice(choice: z.infer<typeof pageChoiceSchema>, secret: string): string {
  const payload = Buffer.from(JSON.stringify(choice)).toString('base64url')
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function verifyChoice(value: string, secret: string): z.infer<typeof pageChoiceSchema> | null {
  const [payload, signature, extra] = value.split('.')
  if (!payload || !signature || extra) return null
  const expected = createHmac('sha256', secret).update(payload).digest()
  let received: Buffer
  try {
    received = Buffer.from(signature, 'base64url')
  } catch {
    return null
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null
  try {
    const choice = pageChoiceSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()))
    return choice.expiresAt > Date.now() ? choice : null
  } catch {
    return null
  }
}

/** The cookie naming the social set settings page a connection started from. */
export const SOCIAL_OAUTH_RETURN_COOKIE = 'shots-oauth-return'

/** Only local brand settings or a draft can be an OAuth return destination. */
export const socialOAuthReturnSchema = z
  .string()
  .regex(/^\/(?:settings\/publishing-brands|publish)\/[a-z0-9]{10,32}$/)

/**
 * Links open the connection start in the browser. A sign-in that is missing or
 * too old for this sensitive action signs in again, then returns to the same
 * start, so the connection continues.
 */
export function socialOAuthSignInRedirect(requestUrl: string): Response {
  const { pathname, search } = new URL(requestUrl)
  const query = new URLSearchParams({ reauthenticate: '1', callbackURL: pathname + search })
  return new Response(null, {
    headers: { 'Cache-Control': 'no-store', Location: `/sign-in?${query}` },
    status: 303,
  })
}

/**
 * Back to where the connection started, which confirms it: the social set's
 * settings (RFC 024), or else the Channels settings.
 */
function connectedRedirect(
  provider: SocialOAuthProvider,
  request: Request,
  returnTo?: string
): Response {
  const cookie = request.headers
    .get('cookie')
    ?.split(/;\s*/)
    .find((part) => part.startsWith(`${SOCIAL_OAUTH_RETURN_COOKIE}=`))
    ?.slice(SOCIAL_OAUTH_RETURN_COOKIE.length + 1)
  let decoded: string | undefined
  try {
    decoded = cookie ? decodeURIComponent(cookie) : undefined
  } catch {
    /* Ignore malformed cookies. */
  }
  const back = socialOAuthReturnSchema.safeParse(returnTo ?? decoded)
  const headers = new Headers({
    'Cache-Control': 'no-store',
    Location: `${back.success ? back.data : '/settings/channels'}?${new URLSearchParams({ connected: provider })}`,
  })
  if (back.success)
    headers.append(
      'Set-Cookie',
      `${SOCIAL_OAUTH_RETURN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
    )
  return new Response(null, { headers, status: 303 })
}

function connectionFailed(provider: SocialOAuthProvider): Response {
  return new Response(`${provider} connection failed. Please start again.`, { status: 502 })
}

export async function completeSocialOAuth(
  request: Request,
  providerName: string,
  completion: SocialOAuthCompletion = {}
): Promise<Response> {
  if (!isSocialOAuthProvider(providerName))
    return new Response('Provider not found.', { status: 404 })
  const params = new URL(request.url).searchParams
  if (params.has('error') || params.has('denied')) {
    return new Response(`${providerName} connection was not completed.`, { status: 400 })
  }

  const state = providerName === 'x' ? params.get('oauth_token') : params.get('state')
  const code = providerName === 'x' ? params.get('oauth_verifier') : params.get('code')
  if (
    !state ||
    !code ||
    (providerName === 'x' && params.has('state') && params.get('state') !== state)
  ) {
    return new Response(`${providerName} connection was not completed.`, { status: 400 })
  }
  if (!completion.exchange)
    return new Response('Social connection is not configured.', { status: 503 })

  const connected = socialOAuthExchangeSchema.safeParse(await completion.exchange(state, code))
  if (!connected.success) return connectionFailed(providerName)
  if (
    !['instagram', 'linkedin-page', 'youtube', 'facebook'].includes(providerName) ||
    connected.data.completed ||
    (providerName !== 'instagram' && !connected.data.pages)
  ) {
    if (
      !connected.data.completed &&
      ['linkedin-page', 'youtube', 'facebook'].includes(providerName)
    )
      await completion.onPageChoice?.(state, connected.data.id)
    await completion.onConnected?.(state, connected.data.id)
    if (completion.redirect) return completion.redirect(state)
    return connectedRedirect(providerName, request, await completion.returnTo?.(state))
  }

  const pages = connected.data.pages ?? []
  if (pages.length === 0) {
    return new Response('No eligible account was found for this provider.', { status: 409 })
  }
  await completion.onPageChoice?.(state, connected.data.id)
  const secret = pickerSecret()
  if (!secret) return new Response('Social connection is not configured.', { status: 503 })
  const options = pages
    .map((page) => {
      const value = signChoice(
        {
          provider: providerName,
          accountId: page.id,
          expiresAt: Date.now() + 10 * 60 * 1000,
          integrationId: connected.data.id,
          pageId: page.pageId,
          state,
        },
        secret
      )
      return `<label><input type="radio" name="choice" value="${htmlEscape(value)}" required> ${htmlEscape(page.name || page.id)}</label>`
    })
    .join('<br>')
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>Select account</title></head><body><main><h1>Select an account</h1><form method="post">${options}<br><button type="submit">Connect account</button></form></main></body></html>`,
    {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'none'; form-action 'self'; base-uri 'none'",
        'Content-Type': 'text/html; charset=utf-8',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    }
  )
}

export async function selectInstagramAccount(
  request: Request,
  selection: InstagramSelection = {},
  provider: SocialOAuthProvider = 'instagram'
): Promise<Response> {
  const origin = request.headers.get('origin')
  if (!isTrustedRequestOrigin(origin)) return new Response('Invalid origin.', { status: 403 })
  const secret = pickerSecret()
  if (!secret) return new Response('Social connection is not configured.', { status: 503 })
  const data = await request.formData().catch(() => null)
  const rawChoice = data?.get('choice')
  const choice = typeof rawChoice === 'string' ? verifyChoice(rawChoice, secret) : null
  if (!choice || choice.provider !== provider)
    return new Response('Account selection expired. Please start again.', { status: 400 })
  if (!selection.selectPage)
    return new Response('Social connection is not configured.', { status: 503 })
  await selection.selectPage(choice)
  await selection.onSelected?.(choice.state, choice.integrationId)
  if (selection.redirect) return selection.redirect(choice.state)
  return connectedRedirect(provider, request, await selection.returnTo?.(choice.state))
}
