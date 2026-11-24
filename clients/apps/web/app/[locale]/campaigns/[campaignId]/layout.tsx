import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { notFound } from 'next/navigation'
import { AskShotsButton } from '@/components/campaign-copilot/CopilotLaunchers'
import { CampaignLocalTime } from '@/components/campaigns/CampaignLocalTime'
import { CampaignStatusPill } from '@/components/campaigns/CampaignStatusPill'
import { CampaignSubnav } from '@/components/launch/CampaignSubnav'
import { AssistantPageContext } from '@/components/assistant/AssistantProvider'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { Page, Pill } from '@/components/platform-ui'
import { backendSDK } from '@/lib/backend/sdk'
import { getCampaignPlans, getReleaseSpecs } from '@/lib/launch/store'
import { latestLaunchRuns } from '@/lib/launch/runs'
import { getCampaign } from '@/lib/tenant/campaigns'
import { requireCampaignPageAccess } from '../page-access'

// Absolute: the root template would add a second suffix, and children set their own.
export const metadata: Metadata = { title: { absolute: 'Campaign | Shots' } }

type CampaignLayoutProps = {
  children: ReactNode
  params: Promise<{ campaignId: string; locale: string }>
}

/** The frame shared by a campaign's pages: title, status, and the page tabs. */
export default async function CampaignLayout({ children, params }: CampaignLayoutProps) {
  const { campaignId, locale } = await params
  const access = await requireCampaignPageAccess(locale)
  // Scoped to the active workspace: another workspace's id is a 404.
  const [campaign, bootstrap] = await Promise.all([
    getCampaign(access.tenant, campaignId),
    backendSDK(access.tenant).getBootstrap(),
  ])
  if (!campaign) notFound()
  const [plans, specs, runs] = await Promise.all([
    getCampaignPlans(access.tenant, campaign.id),
    campaign.release ? getReleaseSpecs(access.tenant, campaign.release.id) : null,
    latestLaunchRuns(access.tenant, campaign.id),
  ])
  const progress =
    runs.produce?.status === 'RUNNING'
      ? 'Producing'
      : runs.plan?.status === 'RUNNING'
        ? 'Planning'
        : runs.spec?.status === 'RUNNING'
          ? 'Drafting spec'
          : campaign.posts.length
            ? campaign.posts.every((post) =>
                ['APPROVED', 'SCHEDULED', 'PUBLISHED'].includes(post.status)
              )
              ? 'Posts approved'
              : 'Copy ready for review'
            : plans.approved
              ? 'Plan approved'
              : plans.latest
                ? 'Plan drafted'
                : specs?.approved
                  ? 'Spec approved'
                  : specs?.latest
                    ? 'Spec drafted'
                    : null

  return (
    <PlatformShell campaignsEnabled organizationName={access.organization.name}>
      <Page
        actions={
          <>
            {campaign.release ? (
              <ButtonLink href={`/releases/${campaign.release.id}`} variant="outline">
                Source release
              </ButtonLink>
            ) : null}
            <AskShotsButton aiEnabled={bootstrap.capabilities.aiAgent} campaignId={campaign.id} />
          </>
        }
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {campaign.status === 'DRAFT' && progress ? (
              <Pill tone="blue">{progress}</Pill>
            ) : (
              <CampaignStatusPill status={campaign.status} />
            )}
            <span>
              Updated <CampaignLocalTime value={campaign.updatedAt.toISOString()} />
            </span>
          </span>
        }
        title={campaign.name}
      >
        {campaign.status === 'ARCHIVED' ? (
          <p className="text-sm text-muted-foreground">
            This campaign is archived and read-only. Restore it from Overview to make changes.
          </p>
        ) : null}
        <AssistantPageContext
          entities={[{ id: campaign.id, name: campaign.name, type: 'campaign' }]}
          facts={[`Campaign status: ${campaign.status}.`]}
        />
        <CampaignSubnav campaignId={campaign.id} />
        {children}
      </Page>
    </PlatformShell>
  )
}
