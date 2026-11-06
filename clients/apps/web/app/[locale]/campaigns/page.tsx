import { campaignLinks } from '@/lib/platform/navigation'
import { AreaNavigation } from '@/components/platform-hub/AreaNavigation'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'
import { CampaignsIcon as MegaphoneIcon } from '@/components/platform-shell/icons'
import type { Metadata } from 'next'
import { ShipInput } from '@/components/campaign-copilot/CopilotLaunchers'
import { CampaignList } from '@/components/campaigns/CampaignList'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { EmptyState, Page } from '@/components/platform-ui'
import { getProductProfile } from '@/lib/tenant/product-profile'
import { backendSDK } from '@/lib/backend/sdk'
import { listCampaigns } from '@/lib/tenant/campaigns'
import { requireCampaignPageAccess } from './page-access'

type CampaignsPageProps = {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ status?: string }>
}

/** The tab title names the Campaigns page shown, as the sidebar does. */
export async function generateMetadata({ searchParams }: CampaignsPageProps): Promise<Metadata> {
  const { status } = await searchParams
  return { title: `${status === 'ARCHIVED' ? 'Archived' : 'All campaigns'} · Campaigns` }
}

/** No campaigns yet. New campaign, in the page's header, is the one way to start. */
function CampaignWorkflows() {
  return (
    <EmptyState
      icon={MegaphoneIcon}
      title="Start your first campaign"
      description="Each one ends with posts you review and approve before anything publishes."
    />
  )
}

export default async function CampaignsPage({ params }: CampaignsPageProps) {
  const { locale } = await params
  const access = await requireCampaignPageAccess(locale)
  const [campaigns, bootstrap, { productSurfaces }, profile] = await Promise.all([
    listCampaigns(access.tenant),
    backendSDK(access.tenant).getBootstrap(),
    backendSDK(access.tenant).listProductSurfaces(),
    getProductProfile(access.tenant),
  ])

  return (
    <PlatformShell campaignsEnabled organizationName={access.organization.name}>
      <Page
        actions={<ButtonLink href="/campaigns/new">New campaign</ButtonLink>}
        description="From release brief to launch."
        title="Campaigns"
      >
        <AreaNavigation label="Campaigns" items={campaignLinks(contentDraftsEnabled())} />
        <ShipInput
          aiEnabled={bootstrap.capabilities.aiAgent}
          hasProfile={Boolean(profile)}
          products={productSurfaces.map(({ name, slug, url }) => ({ name, slug, url }))}
        />
        {campaigns.length === 0 ? (
          <CampaignWorkflows />
        ) : (
          <CampaignList
            campaigns={campaigns.map((campaign) => ({
              id: campaign.id,
              name: campaign.name,
              objective: campaign.objective,
              productName:
                productSurfaces.find((surface) => surface.id === campaign.productSurfaceId)?.name ??
                null,
              releaseTitle: campaign.release?.title ?? null,
              status: campaign.status,
              updatedAt: campaign.updatedAt.toISOString(),
            }))}
          />
        )}
      </Page>
    </PlatformShell>
  )
}
