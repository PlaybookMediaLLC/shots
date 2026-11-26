import { AssistantPageContext } from '@/components/assistant/AssistantProvider'
import { automateLinks } from '@/lib/platform/navigation'
import type { Metadata } from 'next'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Page } from '@/components/platform-ui'
import { AreaNavigation } from '@/components/platform-hub/AreaNavigation'
import { SignedInCapture } from '@/components/workflows/SignedInCapture'
import { requireWorkflowPageAccess } from '../page-access'

export const metadata: Metadata = { title: 'Signed-in capture · Automate' }

export default async function ConnectionsPage({ params }: { params: Promise<{ locale: string }> }) {
  const access = await requireWorkflowPageAccess((await params).locale)
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <AssistantPageContext facts={['Signed-in capture: connected app sessions and capture recipes. Recipes are authored in this page.']} />
      <Page
        title="Signed-in capture"
        description="Screenshot the screens behind your app's sign-in, from a session you connect."
      >
        <AreaNavigation label="Automate" items={automateLinks(access.canManage)} />
        <SignedInCapture canManage={access.canManage} key={access.organization.id} />
      </Page>
    </PlatformShell>
  )
}
