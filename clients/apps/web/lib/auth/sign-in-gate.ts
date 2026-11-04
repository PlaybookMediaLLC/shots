import { getSessionCookie } from 'better-auth/cookies'
import { locales } from '@/i18n/routing'

/**
 * Product pages that need a signed-in account on a paid plan: the standalone
 * editor tools and every image tool. The editor at `/` checks its own access.
 * Marketing, docs, and legal pages stay public.
 */
export const SIGNED_IN_PATHS = [
  '/code',
  '/tweet',
  '/store-screenshots',
  '/compress-video',
  '/remove-background',
  '/mockup-generator',
  '/compress-image',
  '/convert-image',
  '/resize-image',
  '/crop-image',
  '/rotate-image',
  '/png-to-jpg',
  '/jpg-to-png',
  '/png-to-webp',
  '/webp-to-png',
  '/jpg-to-webp',
  '/webp-to-jpg',
  '/avif-to-jpg',
  '/avif-to-png',
  '/png-to-avif',
  '/jpg-to-avif',
  '/webp-to-avif',
  '/avif-to-webp',
] as const

const LOCALE_PREFIX = new RegExp(`^/(${locales.join('|')})(?=/|$)`)

/** The path without its locale prefix, so `/de/code` checks as `/code`. */
function unlocalized(pathname: string): string {
  return pathname.replace(LOCALE_PREFIX, '') || '/'
}

/** Whether a page path belongs to a product page that needs an account. */
export function needsSignIn(pathname: string): boolean {
  const path = unlocalized(pathname)
  return SIGNED_IN_PATHS.some((gated) => path === gated || path.startsWith(`${gated}/`))
}

/** What the gate needs to know about the signed-in visitor, or null without a session. */
export type GateAccess = {
  hasOrganization: boolean
  isWorkspaceOperational: boolean
  hasPaidPlan: boolean
} | null

/**
 * Where to send a visitor who asks for a product page without everything it
 * needs: sign-in (then back to the page), onboarding, workspace recovery, or
 * the in-app plan page for these image tools. Basic scheduling has its own page guard. Null lets the request through.
 * `loadAccess` reads the session and workspace; it runs only on product pages
 * that carry a session cookie.
 */
export async function productPageRedirect(
  request: { headers: Headers; nextUrl: URL },
  loadAccess: (headers: Headers) => Promise<GateAccess>
): Promise<URL | null> {
  if (!needsSignIn(request.nextUrl.pathname)) return null
  const locale = LOCALE_PREFIX.exec(request.nextUrl.pathname)?.[0] ?? ''
  const to = (path: string) => new URL(`${locale}${path}`, request.nextUrl)
  const access = getSessionCookie(request.headers) ? await loadAccess(request.headers) : null
  if (!access) {
    const target = to('/sign-in')
    target.searchParams.set('callbackURL', request.nextUrl.pathname + request.nextUrl.search)
    return target
  }
  if (!access.hasOrganization) return to('/onboarding')
  if (!access.isWorkspaceOperational) return to('/settings')
  if (!access.hasPaidPlan) {
    // The in-app plan page names the tool and returns to it; public pricing drops both.
    const target = to('/upgrade')
    target.searchParams.set('from', unlocalized(request.nextUrl.pathname) + request.nextUrl.search)
    return target
  }
  return null
}
