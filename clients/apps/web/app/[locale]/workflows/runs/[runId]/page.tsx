import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { WorkflowRunDetail } from '@/components/workflows/WorkflowRunDetail'
import { sessionTenant } from '@/lib/auth/page-access'
import { accessAllows } from '@/lib/auth/permissions'
import { getActiveBrand } from '@/lib/launch/store'
import { requireWorkflowPageAccess } from '../../page-access'

export const metadata: Metadata = { title: 'Workflow run' }

type WorkflowRunPageProps = { params: Promise<{ locale: string; runId: string }> }

export default async function WorkflowRunPage({ params }: WorkflowRunPageProps) {
  const [{ locale, runId }, requestHeaders] = await Promise.all([params, headers()])
  const access = await requireWorkflowPageAccess(locale)
  // A run's captured screenshot opens in the editor on the workspace's active
  // kit. The read streams beside the page, only for members who can open the
  // editor, and a failure leaves the link working (null: unreadable).
  const brandKit = accessAllows(access, 'artifact:read')
    ? getActiveBrand(sessionTenant(access, access.organization.id, requestHeaders)).then(
        ({ kitId }) => ({ kitId }),
        () => null
      )
    : Promise.resolve({ kitId: null })
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <WorkflowRunDetail
        brandKit={brandKit}
        canManage={access.canManage}
        id={runId}
        key={`${access.organization.id}:${runId}`}
      />
    </PlatformShell>
  )
}
