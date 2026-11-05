import type { Metadata } from 'next'
import { AreaNavigation } from '@/components/platform-hub/AreaNavigation'
import { ReturnToWork } from '@/components/platform-hub/ReturnToWork'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Page } from '@/components/platform-ui'
import { WorkflowSources } from '@/components/workflows/WorkflowSources'
import { automateLinks } from '@/lib/platform/navigation'
import { requireWorkflowPageAccess } from '../page-access'

export const metadata: Metadata = { title: 'Repositories · Automate' }

export default async function WorkflowSourcesPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const access = await requireWorkflowPageAccess((await params).locale)
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <Page description="Workflows start from the repositories you watch." title="Repositories">
        <ReturnToWork />
        <AreaNavigation label="Automate" items={automateLinks(access.canManage)} />
        <WorkflowSources canManage={access.canManage} key={access.organization.id} />
      </Page>
    </PlatformShell>
  )
}
