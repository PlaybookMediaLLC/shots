import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Page } from '@/components/platform-ui'
import { WorkspaceActivity } from '@/components/workspace/WorkspaceActivity'
import { getLocalizedPath, getPageAccess, upgradePath } from '@/lib/auth/page-access'

export const metadata: Metadata = { title: 'Activity' }

type ActivityPageProps = {
  params: Promise<{ locale: string }>
}

export default async function ActivityPage({ params }: ActivityPageProps) {
  const [{ locale }, requestHeaders] = await Promise.all([params, headers()])
  const access = await getPageAccess(requestHeaders)
  if (!access) redirect(getLocalizedPath(locale, '/sign-in'))
  if (!access.hasOrganization || !access.organization) {
    redirect(getLocalizedPath(locale, '/onboarding'))
  }
  if (!access.isWorkspaceOperational) redirect(getLocalizedPath(locale, '/settings'))
  if (!access.hasPaidPlan) redirect(upgradePath(locale, '/activity'))

  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <Page
        title="Activity"
        description="Everything moving in this workspace: releases, campaigns, announcements, and scheduled posts."
      >
        <WorkspaceActivity />
      </Page>
    </PlatformShell>
  )
}
