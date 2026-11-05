import { automateLinks } from '@/lib/platform/navigation'
import { ReturnToWork } from '@/components/platform-hub/ReturnToWork'
import { AreaNavigation } from '@/components/platform-hub/AreaNavigation'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Page, PlanRequired } from '@/components/platform-ui'
import { WorkflowsDashboard } from '@/components/workflows/WorkflowsDashboard'
import { WorkflowsPageAction } from '@/components/workflows/WorkflowSetup'
import { getLocalizedPath } from '@/lib/auth/page-access'
import { requireWorkflowPageAccess } from './page-access'

export const metadata: Metadata = { title: 'Workflows · Automate' }

type WorkflowsPageProps = {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function WorkflowsPage({ params, searchParams }: WorkflowsPageProps) {
  const { locale } = await params
  const query = await searchParams
  const access = await requireWorkflowPageAccess(locale)
  // Repositories used to be a view of this page, and GitHub returned here.
  if (query.view === 'sources' || query.github) {
    const kept = new URLSearchParams(
      Object.entries(query).flatMap(([key, value]) =>
        key !== 'view' && typeof value === 'string' ? [[key, value]] : []
      )
    ).toString()
    redirect(getLocalizedPath(locale, `/workflows/sources${kept ? `?${kept}` : ''}`))
  }
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <Page
        actions={access.canManage ? <WorkflowsPageAction /> : null}
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
        <AreaNavigation label="Automate" items={automateLinks(access.canManage)} />
        <WorkflowsDashboard canManage={access.canManage} key={access.organization.id} />
      </Page>
    </PlatformShell>
  )
}
