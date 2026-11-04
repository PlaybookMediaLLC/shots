import { notFound } from 'next/navigation'
import { CampaignBrief } from '@/components/campaigns/CampaignBrief'
import { PipelineSteps } from '@/components/launch/PipelineSteps'
import { RevisionHistory } from '@/components/launch/RevisionHistory'
import { accessAllows } from '@/lib/auth/permissions'
import { latestLaunchRuns } from '@/lib/launch/runs'
import { getCampaignPlans, getReleaseSpecs, listRevisions } from '@/lib/launch/store'
import { getCampaign } from '@/lib/tenant/campaigns'
import { listCampaignDesigns } from '@/lib/tenant/designs'
import { requireCampaignPageAccess } from '../page-access'

type CampaignPageProps = {
  params: Promise<{ campaignId: string; locale: string }>
}

const APPROVED_POST = new Set(['APPROVED', 'PUBLISHED', 'SCHEDULED'])

/**
 * The campaign's home: where the launch pipeline stands, the release brief,
 * and recent AI revisions. Everything is read from the server on each
 * request, so a refresh or a new session shows exactly what was saved.
 */
export default async function CampaignPage({ params }: CampaignPageProps) {
  const { campaignId, locale } = await params
  const access = await requireCampaignPageAccess(locale)
  // Scoped to the active workspace: another workspace's id is a 404.
  const campaign = await getCampaign(access.tenant, campaignId)
  if (!campaign) notFound()
  const [specs, plans, runs, revisions, designs] = await Promise.all([
    campaign.release ? getReleaseSpecs(access.tenant, campaign.release.id) : null,
    getCampaignPlans(access.tenant, campaign.id),
    latestLaunchRuns(access.tenant, campaign.id),
    listRevisions(access.tenant, campaign.id),
    listCampaignDesigns(access.tenant, campaign.id),
  ])

  return (
    <>
      <PipelineSteps
        campaignId={campaign.id}
        canEdit={campaign.status !== 'ARCHIVED' && accessAllows(access, 'release:create')}
        hasRelease={Boolean(campaign.release)}
        plan={plans}
        produced={{ designs: designs.length, posts: campaign.posts.length }}
        review={{
          approved: campaign.posts.filter((post) => APPROVED_POST.has(post.status)).length,
          proposals: revisions.filter((revision) => revision.status === 'PROPOSED').length,
          total: campaign.posts.length,
        }}
        runs={runs}
        spec={specs}
      />
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="flex min-w-0 flex-col gap-8">
          <CampaignBrief
            campaign={{
              id: campaign.id,
              postCount: campaign.posts.length,
              status: campaign.status,
            }}
            canApprove={accessAllows(access, 'release:approve')}
            canEdit={accessAllows(access, 'release:create')}
            productSurface={campaign.productSurface}
            release={
              campaign.release && {
                ...campaign.release,
                sourceUrls: Array.isArray(campaign.release.sourceUrls)
                  ? (campaign.release.sourceUrls as unknown[]).filter(
                      (url): url is string => typeof url === 'string'
                    )
                  : [],
              }
            }
          />
        </div>
        <RevisionHistory
          campaignId={campaign.id}
          revisions={revisions.slice(0, 8).map((revision) => ({
            comment: revision.comment,
            createdAt: revision.createdAt,
            id: revision.id,
            label: revision.proposal.primary?.label ?? revision.targetType,
            status: revision.status,
            summary: revision.proposal.summary ?? '',
            targetKey: revision.targetKey,
            targetType: revision.targetType,
          }))}
        />
      </div>
    </>
  )
}
