import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { Suspense } from 'react'
import { AuthForm } from '@/components/auth/AuthForm'
import { AuthShell } from '@/components/auth/AuthShell'
import { getEnabledSocialProviders, isPasswordAuthEnabled } from '@/lib/auth/methods'
import { redirectIfSignedIn } from '@/lib/auth/page-access'

export const metadata: Metadata = { title: 'Create account' }

type AuthPageProps = {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ callbackURL?: string | string[]; sig?: string }>
}

export default async function SignUpPage({ params, searchParams }: AuthPageProps) {
  const [{ locale }, { callbackURL, sig }, requestHeaders] = await Promise.all([
    params,
    searchParams,
    headers(),
  ])
  if (!sig) await redirectIfSignedIn(requestHeaders, locale, callbackURL)

  return (
    <AuthShell
      description="Create an account, then set up your team workspace."
      eyebrow="Step 1 of 2"
      title="Create your account"
    >
      <Suspense fallback={null}>
        <AuthForm
          mode="sign-up"
          passwordAuthEnabled={isPasswordAuthEnabled()}
          socialProviders={getEnabledSocialProviders()}
        />
      </Suspense>
    </AuthShell>
  )
}
