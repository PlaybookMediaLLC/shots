import { z } from 'zod'

const redirectResponse = z.object({ redirect: z.literal(true), url: z.string().url() })
const nativeSchemes = new Set(['anarlog:', 'anarlog-dev:', 'anarlog-staging:', 'anarlog-nightly:'])

/** Only the authenticated server response may supply an OAuth redirect. */
export function authRedirect(data: unknown, fallback: string): string {
  const response = redirectResponse.safeParse(data)
  if (!response.success) return fallback
  const url = new URL(response.data.url)
  if (
    url.protocol === 'https:' ||
    url.protocol === 'http:' ||
    (nativeSchemes.has(url.protocol) && url.host === 'auth' && url.pathname === '/callback')
  )
    return url.toString()
  throw new Error('The sign-in server returned an invalid redirect.')
}

/** Keep the provider's signed request intact through sign-up and two-factor verification. */
export function authPageSearch(search: string, callbackURL: string): string {
  const params = new URLSearchParams(search)
  if (!params.has('sig')) return new URLSearchParams({ callbackURL }).toString()
  return params.toString()
}
