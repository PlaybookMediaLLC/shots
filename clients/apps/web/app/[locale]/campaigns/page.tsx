import { AreaNavigation, CAMPAIGN_LINKS } from '@/components/platform-hub/AreaNavigation'
import { CampaignsIcon as MegaphoneIcon } from '@/components/platform-shell/icons'
import { CalendarIcon as Calendar03Icon } from '@/components/platform-shell/icons'
import { CampaignsIcon as Megaphone01Icon } from '@/components/platform-shell/icons'
import { RocketIcon as Rocket01Icon } from '@/components/platform-shell/icons'
import type { Metadata } from 'next'
import { ShipInput } from '@/components/campaign-copilot/CopilotLaunchers'
import { CampaignList } from '@/components/campaigns/CampaignList'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { EmptyState, Page, Pill } from '@/components/platform-ui'
import { getProductProfile } from '@/lib/tenant/product-profile'
import { backendSDK } from '@/lib/backend/sdk'
import { listCampaigns } from '@/lib/tenant/campaigns'
import { requireCampaignPageAccess } from './page-access'

export const metadata: Metadata = { title: 'Campaigns' }

type CampaignsPageProps = {
  params: Promise<{ locale: string }>
}

/** The three RFC 048 workflows; a workflow without an href is planned, not offered yet. */
const WORKFLOWS = [
  {
    description: 'Add your product and release brief, then draft launch posts to approve.',
    href: '/campaigns/new',
    icon: Rocket01Icon,
    label: 'Start the launch',
    primary: true,
    title: 'Launch your product',
  },
  {
    description: 'Describe a release you shipped and build a campaign around that feature.',
    href: '/campaigns/new',
    icon: Megaphone01Icon,
    label: 'Add a release',
    primary: false,
    title: 'Announce a feature',
  },
  {
    description: 'A weekly batch of fresh posts from what your product already does.',
    href: null,
    icon: Calendar03Icon,
    label: null,
    primary: false,
    title: 'Stay visible',
  },
] as const

/** No campaigns yet: the three ways to start one, as the primary actions. */
function CampaignWorkflows() {
  return (
    <section aria-label="Start your first campaign" className="flex flex-col gap-6">
      <EmptyState
        icon={MegaphoneIcon}
        title="Start your first campaign"
        description="Each one ends with posts you review and approve before anything publishes."
      />
      <ul className="grid gap-3 md:grid-cols-3">
        {WORKFLOWS.map((workflow) => (
          <li
            aria-disabled={workflow.href === null || undefined}
            className="flex flex-col gap-4 rounded-xl bg-foreground/[0.015] p-5 ring-1 ring-foreground/[0.08] aria-disabled:opacity-60"
            key={workflow.title}
          >
            <div className="flex items-center justify-between gap-2">
              <workflow.icon className="text-foreground/65" size={22} />
              {workflow.href === null ? <Pill>Planned</Pill> : null}
            </div>
            <div className="flex-1">
              <h3 className="text-ui-lg font-medium text-foreground">{workflow.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{workflow.description}</p>
            </div>
            {workflow.href ? (
              <ButtonLink
                className="self-start rounded-lg"
                href={workflow.href}
                size="sm"
                variant={workflow.primary ? 'default' : 'outline'}
              >
                {workflow.label}
              </ButtonLink>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
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
        <AreaNavigation label="Campaigns" items={CAMPAIGN_LINKS} />
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
