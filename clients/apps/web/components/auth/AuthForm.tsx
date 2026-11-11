'use client'

import { platformHref, safeReturnPath } from '@/lib/platform/navigation'

import { useEffect, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { authClient } from '@/lib/auth/client'
import { authPageSearch, authRedirect } from '@/lib/auth/oauth-navigation'
import type { SocialProvider } from '@/lib/auth/methods'
import { getAuthErrorMessage } from './error-message'
import { AuthField, Divider, FormAlert, SubmitButton } from './fields'
import { SsoSignInForm } from './SsoSignInForm'

const signInSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
})

const signUpSchema = signInSchema.extend({
  name: z.string().trim().min(1, 'Enter your name.').max(100),
  password: z.string().min(12, 'Use at least 12 characters.'),
})

const PROVIDER_LABELS: Record<SocialProvider, string> = {
  github: 'GitHub',
  google: 'Google',
  microsoft: 'Microsoft',
  linkedin: 'LinkedIn',
  twitter: 'X',
}

type AuthFormProps = {
  mode: 'sign-in' | 'sign-up'
  /** Providers with credentials configured. Rendering a provider the server
   * cannot service produces an opaque failure when the user clicks it. */
  socialProviders: SocialProvider[]
  passwordAuthEnabled: boolean
}

function getCallbackUrl(value: string | null): string {
  return safeReturnPath(value)
}

export function AuthForm({ mode, passwordAuthEnabled, socialProviders }: AuthFormProps) {
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const [error, setError] = useState<string | null>(null)
  const [isHydrated, setIsHydrated] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const isSignUp = mode === 'sign-up'
  const callbackURL = searchParams.has('sig')
    ? platformHref(pathname, `/sign-in?${searchParams.toString()}`)
    : platformHref(pathname, getCallbackUrl(searchParams.get('callbackURL')))
  const hasSocialProviders = socialProviders.length > 0

  useEffect(() => {
    setIsHydrated(true)
  }, [])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setMessage(null)
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form))
    setIsSubmitting(true)
    try {
      if (isSignUp) {
        const input = signUpSchema.safeParse(values)
        if (!input.success) {
          setError(input.error.issues[0]?.message ?? 'Check the form values.')
          return
        }
        const result = await authClient.signUp.email({ ...input.data, callbackURL })
        if (result.error)
          throw new Error(
            result.error.message || 'Account creation is unavailable. Please try again.'
          )
        if (result.data?.token || (result.data && 'redirect' in result.data)) {
          window.location.assign(
            authRedirect(
              result.data,
              !searchParams.get('callbackURL') ? '/onboarding' : callbackURL
            )
          )
          return
        }
        setMessage('Check your email to verify your account, then sign in.')
        form.reset()
      } else {
        const input = signInSchema.safeParse(values)
        if (!input.success) {
          setError(input.error.issues[0]?.message ?? 'Check the form values.')
          return
        }
        const result = await authClient.signIn.email({ ...input.data, callbackURL })
        if (result.error)
          throw new Error(result.error.message || 'Sign-in is unavailable. Please try again.')
        if (result.data && 'twoFactorRedirect' in result.data && result.data.twoFactorRedirect)
          return
        window.location.assign(authRedirect(result.data, callbackURL))
      }
    } catch (requestError) {
      setError(getAuthErrorMessage(requestError, 'Authentication failed. Please try again.'))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleSocialSignIn(provider: SocialProvider) {
    setError(null)
    const result = await authClient.signIn.social({ callbackURL, provider })
    if (result.error) setError(result.error.message || 'Social sign-in failed. Please try again.')
  }

  return (
    <div className="space-y-6">
      {passwordAuthEnabled ? (
        <form className="space-y-5" onSubmit={handleSubmit}>
          {isSignUp ? (
            <AuthField autoComplete="name" id="name" label="Name" name="name" required />
          ) : null}
          <AuthField
            autoComplete="email"
            id="email"
            label="Email"
            name="email"
            placeholder="you@company.com"
            required
            type="email"
          />
          <AuthField
            autoComplete={isSignUp ? 'new-password' : 'current-password'}
            hint={isSignUp ? 'At least 12 characters.' : undefined}
            id="password"
            label="Password"
            minLength={isSignUp ? 12 : undefined}
            name="password"
            required
            type="password"
          />
          {error ? <FormAlert>{error}</FormAlert> : null}
          {message ? <FormAlert tone="info">{message}</FormAlert> : null}
          <SubmitButton
            busy={isSubmitting}
            busyLabel={isSignUp ? 'Creating account…' : 'Signing in…'}
            disabled={!isHydrated}
          >
            {isSignUp ? 'Create account' : 'Sign in'}
          </SubmitButton>
        </form>
      ) : null}

      {!passwordAuthEnabled && error ? <FormAlert>{error}</FormAlert> : null}

      {hasSocialProviders || !isSignUp ? (
        <div className="space-y-3">
          {passwordAuthEnabled ? <Divider>or</Divider> : null}
          {hasSocialProviders ? (
            <div
              className={
                socialProviders.length > 2 ? 'grid grid-cols-3 gap-2' : 'grid grid-cols-1 gap-2'
              }
            >
              {socialProviders.map((provider) => (
                <Button
                  className="h-10 rounded-lg border-white/[0.08] bg-white/[0.04] shadow-none hover:bg-white/[0.07] dark:border-white/[0.08] dark:bg-white/[0.04]"
                  key={provider}
                  onClick={() => handleSocialSignIn(provider)}
                  type="button"
                  variant="outline"
                >
                  {socialProviders.length > 2
                    ? PROVIDER_LABELS[provider]
                    : `Continue with ${PROVIDER_LABELS[provider]}`}
                </Button>
              ))}
            </div>
          ) : null}
          {!isSignUp ? <SsoSignInForm callbackURL={callbackURL} /> : null}
        </div>
      ) : null}

      {passwordAuthEnabled ? (
        <p className="text-center text-sm text-muted-foreground">
          {isSignUp ? 'Already have an account?' : 'New to Shots?'}{' '}
          <Link
            className="font-medium text-foreground underline-offset-4 hover:underline"
            href={`${isSignUp ? '/sign-in' : '/sign-up'}?${authPageSearch(searchParams.toString(), callbackURL)}`}
          >
            {isSignUp ? 'Sign in' : 'Create an account'}
          </Link>
        </p>
      ) : null}
    </div>
  )
}
