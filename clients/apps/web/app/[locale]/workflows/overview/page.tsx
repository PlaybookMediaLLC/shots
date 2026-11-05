import type { Metadata } from 'next'
import { AreaNavigation } from '@/components/platform-hub/AreaNavigation'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Page, PlanRequired } from '@/components/platform-ui'
import { AutomateOverview } from '@/components/workflows/AutomateOverview'
import { WorkflowsPageAction } from '@/components/workflows/WorkflowSetup'
import { automateLinks } from '@/lib/platform/navigation'
import { requireWorkflowPageAccess } from '../page-access'

export const metadata: Metadata = { title: 'Overview · Automate' }

export default async function AutomateOverviewPage({
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
      <Page
        actions={access.canManage ? <WorkflowsPageAction /> : null}
        description="Turn shipped code into ready-to-review campaigns."
        title="Automate"
      >
        {access.hasPaidPlan ? null : (
          // Runs create releases and campaigns, which need a paid plan.
          <PlanRequired from="/workflows/overview">
            Running workflows creates releases and campaign drafts, which need Pro.
          </PlanRequired>
        )}
        <AreaNavigation label="Automate" items={automateLinks(access.canManage)} />
        <AutomateOverview canManage={access.canManage} key={access.organization.id} />
      </Page>
    </PlatformShell>
  )
}
