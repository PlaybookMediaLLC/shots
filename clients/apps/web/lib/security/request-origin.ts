import { getAuthBaseUrl, getTrustedOrigins } from '@/lib/auth/environment'

/**
 * Cookies authenticate a person, not the page submitting a request. Reject
 * cross-origin browser writes, including a malicious sibling subdomain (which
 * SameSite cookies permit). Non-browser API clients without Origin/Fetch
 * Metadata remain supported, as do cookie-free signed webhooks and API keys.
 */
export function isCrossOriginCookieMutation(request: Request): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || !request.headers.get('cookie')) {
    return false
  }
  const origin = request.headers.get('origin')
  if (origin !== null) return !isTrustedRequestOrigin(origin)
  const site = request.headers.get('sec-fetch-site')
  return site !== null && site !== 'same-origin'
}

/** Uses configured public origins because reverse proxies can change the request URL. */
export function isTrustedRequestOrigin(origin: string | null): boolean {
  const trusted = [getAuthBaseUrl(), ...getTrustedOrigins()]
  return (
    origin !== null &&
    trusted.some((value) => URL.canParse(value) && new URL(value).origin === origin)
  )
}
