import { AuthShell } from '@/components/auth/AuthShell'
import { FounderHubConsent } from '@/components/auth/FounderHubConsent'
import { Suspense } from 'react'

export default function FounderHubConsentPage() {
  return (
    <AuthShell
      title="Connect Founder Hub"
      description="Your account and access stay managed by Shots."
    >
      <Suspense fallback={null}>
        <FounderHubConsent />
      </Suspense>
    </AuthShell>
  )
}
