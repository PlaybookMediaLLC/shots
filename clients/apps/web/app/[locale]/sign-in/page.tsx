import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { Suspense } from 'react'
import { AuthForm } from '@/components/auth/AuthForm'
import { AuthShell } from '@/components/auth/AuthShell'
import { getEnabledSocialProviders, isPasswordAuthEnabled } from '@/lib/auth/methods'
import { redirectIfSignedIn } from '@/lib/auth/page-access'

export const metadata: Metadata = { title: 'Sign in' }

type AuthPageProps = {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ callbackURL?: string | string[]; reauthenticate?: string; sig?: string }>
}

export default async function SignInPage({ params, searchParams }: AuthPageProps) {
  const [{ locale }, { callbackURL, reauthenticate, sig }, requestHeaders] = await Promise.all([
    params,
    searchParams,
    headers(),
  ])
  if (!sig && reauthenticate !== '1') await redirectIfSignedIn(requestHeaders, locale, callbackURL)

  return (
    <AuthShell
      description={
        reauthenticate === '1'
          ? 'Sign in again to confirm your identity. You will return to settings afterward.'
          : 'Sign in to access your team workspace.'
      }
      title={reauthenticate === '1' ? 'Verify your identity' : 'Welcome back'}
    >
      <Suspense fallback={null}>
        <AuthForm
          mode="sign-in"
          passwordAuthEnabled={isPasswordAuthEnabled()}
          socialProviders={getEnabledSocialProviders()}
        />
      </Suspense>
    </AuthShell>
  )
}
