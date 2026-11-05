import { automateLinks } from '@/lib/platform/navigation'
import { AreaNavigation } from '@/components/platform-hub/AreaNavigation'
import type { Metadata } from 'next'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Page } from '@/components/platform-ui'
import { WorkflowRuns } from '@/components/workflows/WorkflowRuns'
import { requireWorkflowPageAccess } from '../page-access'

export const metadata: Metadata = { title: 'Runs · Automate' }

type WorkflowRunsPageProps = { params: Promise<{ locale: string }> }

export default async function WorkflowRunsPage({ params }: WorkflowRunsPageProps) {
  const access = await requireWorkflowPageAccess((await params).locale)
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <Page
        description="What happened each time a watched repository shipped something."
        title="Runs"
      >
        <AreaNavigation label="Automate" items={automateLinks(access.canManage)} />
        <WorkflowRuns key={access.organization.id} />
      </Page>
    </PlatformShell>
  )
}
