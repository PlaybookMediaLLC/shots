import { campaignLinks } from '@/lib/platform/navigation'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Page } from '@/components/platform-ui'
import { AreaNavigation } from '@/components/platform-hub/AreaNavigation'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { requireCampaignPageAccess } from '../page-access'
import { ReleaseSourceInbox } from '@/components/releases/ReleaseSourceSelection'
import { accessAllows } from '@/lib/auth/permissions'

export const metadata = { title: 'Release inbox · Campaigns' }
export default async function ReleaseInbox({ params }: { params: Promise<{ locale: string }> }) {
  const access = await requireCampaignPageAccess((await params).locale)
  return (
    <PlatformShell campaignsEnabled organizationName={access.organization.name}>
      <Page
        title="Release inbox"
        description="Review product changes and source evidence, then open or start the release they belong to."
        actions={
          <ButtonLink href="/workflows/sources" variant="outline">
            Watch a repository
          </ButtonLink>
        }
      >
        <AreaNavigation label="Campaigns" items={campaignLinks(contentDraftsEnabled())} />
        <ReleaseSourceInbox
          key={access.organization.id}
          scope={{ userId: access.session.user.id, workspaceId: access.organization.id }}
          enabled={access.organization.workspaceSettings?.releaseReadinessEnabled ?? false}
          canEdit={accessAllows(access, 'release:create')}
        />
      </Page>
    </PlatformShell>
  )
}
