import { AUTOMATE_LINKS } from '@/lib/platform/navigation'
import { ReturnToWork } from '@/components/platform-hub/ReturnToWork'
import { AreaNavigation } from '@/components/platform-hub/AreaNavigation'
import type { Metadata } from 'next'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Page, PlanRequired } from '@/components/platform-ui'
import { WorkflowsDashboard } from '@/components/workflows/WorkflowsDashboard'
import { requireWorkflowPageAccess } from './page-access'

export const metadata: Metadata = { title: 'Workflows · Automate' }

type WorkflowsPageProps = { params: Promise<{ locale: string }> }

export default async function WorkflowsPage({ params }: WorkflowsPageProps) {
  const access = await requireWorkflowPageAccess((await params).locale)
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <Page
        actions={
          access.canManage ? <ButtonLink href="/workflows/new">New workflow</ButtonLink> : null
        }
        description="Shipped changes become reviewable campaigns."
        title="Workflows"
      >
        <ReturnToWork />
        {access.hasPaidPlan ? null : (
          // Runs create releases and campaigns, which need a paid plan.
          <PlanRequired from="/workflows">
            Running workflows creates releases and campaign drafts, which need Pro.
          </PlanRequired>
        )}
        <AreaNavigation label="Automate" items={AUTOMATE_LINKS} />
        <WorkflowsDashboard canManage={access.canManage} key={access.organization.id} />
      </Page>
    </PlatformShell>
  )
}
