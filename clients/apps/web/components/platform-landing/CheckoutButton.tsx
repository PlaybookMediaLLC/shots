'use client'

import Link from 'next/link'
import { useState } from 'react'
import type { z } from 'zod'
import { locales } from '@/i18n/routing'
import { trackCTAClick } from '@/lib/analytics'
import { safeReturnPath } from '@/lib/platform/navigation'
import { cn } from '@/lib/utils'
import { ctaClassName } from './CtaLink'
import { checkoutPathSchema, ctaToneSchema } from './primitives'
import { Button } from '@/components/ui/button'

const LOCALE_PREFIX = new RegExp(`^/(${locales.join('|')})(?=/|$)`)

/** The web layer's message when the caller's role lacks the permission. */
const NO_PERMISSION = 'You do not have permission for this organization.'

/**
 * Opens Stripe Checkout (or the billing portal) for the signed-in workspace.
 * The first choice is the main button; the rest are quiet text buttons, e.g.
 * annual billing. Signed-out visitors sign in first; until Stripe is
 * configured, the request falls back to the contact page.
 */
export function CheckoutButton({
  choices,
  className,
  location,
  path,
  surface = 'landing',
}: {
  choices: { body: Record<string, string>; label: string }[]
  className?: string
  location: string
  path: z.infer<typeof checkoutPathSchema>
  /** `'app'` renders a theme-aware outline button for signed-in settings pages. */
  surface?: 'landing' | 'app'
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsWorkspace, setNeedsWorkspace] = useState(false)

  async function start(choice: (typeof choices)[number]) {
    trackCTAClick(location, choice.label)
    setBusy(true)
    setError(null)
    setNeedsWorkspace(false)
    // The in-app page that sent the buyer here is where Checkout returns them.
    const returnTo = safeReturnPath(new URLSearchParams(window.location.search).get('returnTo'), '')
    const response = await fetch(path, {
      body: JSON.stringify(
        returnTo && path === checkoutPathSchema.enum['/api/billing/checkout']
          ? { ...choice.body, returnTo }
          : choice.body
      ),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }).catch(() => null)
    const body = (await response?.json().catch(() => null)) as {
      code?: string
      message?: string
      url?: string
    } | null
    if (response?.ok && body?.url) return window.location.assign(body.url)
    if (response?.status === 401) {
      const { pathname, search } = window.location
      const locale = LOCALE_PREFIX.exec(pathname)?.[0] ?? ''
      return window.location.assign(
        `${locale}/sign-in?callbackURL=${encodeURIComponent(pathname + search)}`
      )
    }
    if (response?.status === 503) return window.location.assign('/contact')
    setBusy(false)
    if (response?.status === 403 && body?.message === NO_PERMISSION) {
      return setError('Only workspace owners and admins can manage billing.')
    }
    // A signed-in account with no workspace to bill is refused by the backend.
    if (response?.status === 403 && body?.code !== 'workspace_feature_not_entitled') {
      return setNeedsWorkspace(true)
    }
    setError(body?.message ?? 'Checkout could not start. Try again.')
  }

  const [main, ...others] = choices
  return (
    <div className={cn('flex flex-col items-center gap-2', className)}>
      {surface === 'app' ? (
        <Button
          className="w-full justify-center rounded-lg"
          disabled={busy}
          onClick={() => start(main)}
          size="sm"
          type="button"
          variant="outline"
        >
          {busy ? 'Opening Stripe…' : main.label}
        </Button>
      ) : (
        <Button
          variant="custom"
          size={null}
          className={cn(
            ctaClassName(ctaToneSchema.enum.secondary),
            'w-full justify-center disabled:opacity-60'
          )}
          disabled={busy}
          onClick={() => start(main)}
          type="button"
        >
          {main.label}
        </Button>
      )}
      {others.map((choice) => (
        <Button variant="custom" size={null}
          className={cn(
            'text-[13px] underline-offset-4 hover:underline disabled:opacity-60',
            surface === 'app'
              ? 'text-muted-foreground hover:text-foreground'
              : 'text-white/60 hover:text-white'
          )}
          disabled={busy}
          key={choice.label}
          onClick={() => start(choice)}
          type="button"
        >
          {choice.label}
        </Button>
      ))}
      {needsWorkspace ? (
        <p
          className={cn(
            'text-center text-[13px]',
            surface === 'app' ? 'text-muted-foreground' : 'text-white/70'
          )}
          role="alert"
        >
          Create a workspace first.{' '}
          <Link
            className={cn(
              'underline underline-offset-4',
              surface === 'app' ? 'text-foreground' : 'text-white'
            )}
            href="/onboarding"
          >
            Set one up
          </Link>
        </p>
      ) : null}
      {error ? (
        <p
          className={cn(
            'text-center text-[13px]',
            surface === 'app' ? 'text-destructive' : 'text-red-300'
          )}
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  )
}
