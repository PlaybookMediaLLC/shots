import { automateLinks } from '@/lib/platform/navigation'
import type { Metadata } from 'next'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Page } from '@/components/platform-ui'
import { AreaNavigation } from '@/components/platform-hub/AreaNavigation'
import { FrontendDeployments } from '@/components/workflows/FrontendDeployments'
import { requireWorkflowPageAccess } from '../page-access'

export const metadata: Metadata = { title: 'Deployments · Automate' }

export default async function DeploymentPage({ params }: { params: Promise<{ locale: string }> }) {
  const access = await requireWorkflowPageAccess((await params).locale)
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <Page
        title="Deployments"
        description="Send an alert or start a workflow when a production deployment goes live."
      >
        <AreaNavigation label="Automate" items={automateLinks(access.canManage)} />
        <FrontendDeployments canManage={access.canManage} key={access.organization.id} />
      </Page>
    </PlatformShell>
  )
}
