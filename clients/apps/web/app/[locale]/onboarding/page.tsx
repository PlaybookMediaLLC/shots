import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { OnboardingForm } from '@/components/auth/OnboardingForm'
import { ONBOARDING_STEPS, OnboardingShell } from '@/components/auth/OnboardingShell'
import { SignOutButton } from '@/components/auth/SignOutButton'
import { getLocalizedPath, getPageAccess } from '@/lib/auth/page-access'

export const metadata = { title: 'Create your workspace' }

type OnboardingPageProps = {
  params: Promise<{ locale: string }>
}

export default async function OnboardingPage({ params }: OnboardingPageProps) {
  const [{ locale }, requestHeaders] = await Promise.all([params, headers()])
  const access = await getPageAccess(requestHeaders)
  if (!access) redirect(getLocalizedPath(locale, '/sign-in'))
  return (
    <OnboardingShell
      current={1}
      footer={
        <div className="flex flex-col gap-1">
          <span className="truncate">
            Signed in as <span className="text-neutral-300">{access.session.user.email}</span>
          </span>
          <SignOutButton className="h-auto w-fit p-0 text-xs text-neutral-400" variant="link" />
        </div>
      }
      steps={ONBOARDING_STEPS}
    >
      <OnboardingForm />
    </OnboardingShell>
  )
}
