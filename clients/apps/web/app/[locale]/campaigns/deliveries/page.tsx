import { campaignLinks } from '@/lib/platform/navigation'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Page, Pill } from '@/components/platform-ui'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import { AreaNavigation } from '@/components/platform-hub/AreaNavigation'
import { notFound, redirect } from 'next/navigation'
import { upgradePath } from '@/lib/auth/page-access'
import { getCampaign, listCampaigns } from '@/lib/tenant/campaigns'
import { requireDraftsPageAccess } from '../../drafts/page-access'
import { CampaignLocalTime } from '@/components/campaigns/CampaignLocalTime'

export const metadata = { title: 'Deliveries · Campaigns' }
export default async function CampaignDeliveries({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ campaign?: string }>
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams])
  const access = await requireDraftsPageAccess(locale, '/campaigns/deliveries')
  // Campaigns need Pro, like the Campaigns area itself.
  if (!access.campaignWorkflowEnabled) notFound()
  if (!access.hasPaidPlan) redirect(upgradePath(locale, '/campaigns/deliveries'))
  const campaigns = await listCampaigns(access.tenant)
  const selected = campaigns.find((campaign) => campaign.id === query.campaign)
  const campaign = selected ? await getCampaign(access.tenant, selected.id) : null
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <Page
        title="Deliveries"
        description="Campaign posts keep their original review and approval history. Choose a campaign to see where each of its posts is in delivery; freeform posts are in Publish › Calendar."
      >
        <AreaNavigation label="Campaigns" items={campaignLinks(true)} />
        <nav aria-label="Choose campaign" className="flex flex-wrap gap-2">
          {campaigns.map((item) => (
            <SidebarLink
              key={item.id}
              aria-current={item.id === selected?.id ? 'page' : undefined}
              className="rounded-lg border px-3 py-2 text-sm aria-[current=page]:bg-muted"
              href={`/campaigns/deliveries?campaign=${item.id}`}
            >
              {item.name}
              {item.status === 'ARCHIVED' ? ' · Archived' : ''}
            </SidebarLink>
          ))}
        </nav>
        {campaign ? (
          <section className="space-y-4">
            <h2 className="text-lg font-medium">{campaign.name}</h2>
            {campaign.status === 'ARCHIVED' ? (
              <p className="text-sm text-muted-foreground">Archived campaign · Read only</p>
            ) : null}
            {campaign.posts.length ? (
              <ul className="divide-y rounded-xl border">
                {campaign.posts.map((post) => (
                  <li className="space-y-2 p-4" key={post.id}>
                    <SidebarLink
                      className="font-medium underline"
                      href={`/campaigns/${campaign.id}/copy?channel=${encodeURIComponent(post.channel)}#post-${post.id}`}
                    >
                      {post.title || post.copy.slice(0, 100) || 'Campaign post'}
                    </SidebarLink>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span>{post.channel}</span>
                      <Pill>
                        Review:{' '}
                        {post.approvedAt
                          ? 'Approved revision'
                          : post.status === 'SCHEDULED' || post.status === 'PUBLISHED'
                            ? 'See approval history'
                            : post.status.replaceAll('_', ' ').toLowerCase()}
                      </Pill>
                      <Pill>
                        Delivery:{' '}
                        {post.scheduledPostStatus?.replaceAll('_', ' ').toLowerCase() ??
                          'Not scheduled'}
                      </Pill>
                      {post.scheduledAt ? (
                        <span>
                          <CampaignLocalTime value={post.scheduledAt.toISOString()} />
                        </span>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Current readiness and scheduling are checked in campaign review.
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p>No campaign posts yet. Open the campaign to prepare content.</p>
            )}
          </section>
        ) : (
          <p className="text-sm text-muted-foreground">
            {campaigns.length
              ? 'Choose a campaign to inspect its posts and open the original review.'
              : 'No campaigns available in this workspace.'}
          </p>
        )}
      </Page>
    </PlatformShell>
  )
}
