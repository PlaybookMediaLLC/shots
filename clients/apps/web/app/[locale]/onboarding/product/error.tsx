'use client'

import { ONBOARDING_STEPS, OnboardingShell } from '@/components/auth/OnboardingShell'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

/** A failed profile read must not offer to overwrite it with new setup. */
export default function ProductSetupError({ retry }: { retry: () => void }) {
  return (
    <OnboardingShell current={3} steps={ONBOARDING_STEPS}>
      <div className="flex flex-1 flex-col gap-6 px-6 py-10">
        <Alert variant="destructive">
          <AlertTitle>Your product could not load</AlertTitle>
          <AlertDescription>
            Your saved product details have not been changed. Try loading them again before
            continuing setup.
          </AlertDescription>
        </Alert>
        <div className="flex flex-wrap gap-3">
          <Button onClick={retry}>Try again</Button>
          <ButtonLink href="/home" variant="outline">
            Open Home
          </ButtonLink>
        </div>
      </div>
    </OnboardingShell>
  )
}
