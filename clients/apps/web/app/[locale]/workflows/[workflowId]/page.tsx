import { AssistantPageContext } from '@/components/assistant/AssistantProvider'
import type { Metadata } from 'next'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { WorkflowDefinitionEditor } from '@/components/workflows/WorkflowDefinitionEditor'
import { requireWorkflowPageAccess } from '../page-access'

export const metadata: Metadata = { title: 'Workflow' }

type WorkflowPageProps = { params: Promise<{ locale: string; workflowId: string }> }

export default async function WorkflowPage({ params }: WorkflowPageProps) {
  const { locale, workflowId } = await params
  const access = await requireWorkflowPageAccess(locale)
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <AssistantPageContext facts={['Editing one automation workflow.']} />
      <WorkflowDefinitionEditor
        canManage={access.canManage}
        id={workflowId}
        key={`${access.organization.id}:${workflowId}`}
      />
    </PlatformShell>
  )
}
