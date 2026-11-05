import { campaignLinks } from '@/lib/platform/navigation'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Page } from '@/components/platform-ui'
import { AreaNavigation } from '@/components/platform-hub/AreaNavigation'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'
import { WorkspaceActivity } from '@/components/workspace/WorkspaceActivity'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { requireCampaignPageAccess } from '../page-access'

export const metadata = { title: 'Release inbox · Campaigns' }
export default async function ReleaseInbox({ params }: { params: Promise<{ locale: string }> }) {
  const access = await requireCampaignPageAccess((await params).locale)
  return (
    <PlatformShell campaignsEnabled organizationName={access.organization.name}>
      <Page
        title="Release inbox"
        description="What shipped, ready to launch: product changes and source evidence for your next campaign."
        actions={
          <ButtonLink href="/workflows/sources" variant="outline">
            Watch a repository
          </ButtonLink>
        }
      >
        <AreaNavigation label="Campaigns" items={campaignLinks(contentDraftsEnabled())} />
        <WorkspaceActivity sections={['releases']} />
      </Page>
    </PlatformShell>
  )
}
