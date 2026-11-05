import { VerifiedIcon as DocumentValidationIcon } from '@/components/platform-shell/icons'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { PlanView } from '@/components/launch/plan/PlanView'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { EmptyState } from '@/components/platform-ui'
import { isCampaignStudioConfigured } from '@/lib/ai/agents/campaign-studio'
import { accessAllows } from '@/lib/auth/permissions'
import { latestLaunchRuns } from '@/lib/launch/runs'
import { getCampaignPlans, getPlanById, getReleaseSpecs, getSpecById } from '@/lib/launch/store'
import { getCampaign } from '@/lib/tenant/campaigns'
import { requireCampaignPageAccess } from '../../page-access'

export const metadata: Metadata = { title: 'Campaign plan' }

type PlanPageProps = {
  params: Promise<{ campaignId: string; locale: string }>
  searchParams: Promise<{ version?: string | string[] }>
}

export default async function PlanPage({ params, searchParams }: PlanPageProps) {
  const [{ campaignId, locale }, { version }] = await Promise.all([params, searchParams])
  const access = await requireCampaignPageAccess(locale)
  const campaign = await getCampaign(access.tenant, campaignId)
  if (!campaign) notFound()
  const [plans, specs, runs] = await Promise.all([
    getCampaignPlans(access.tenant, campaign.id),
    campaign.release ? getReleaseSpecs(access.tenant, campaign.release.id) : null,
    latestLaunchRuns(access.tenant, campaign.id),
  ])
  const workingSpec = specs ? (specs.approved ?? specs.latest) : null
  if (!workingSpec) {
    return (
      <EmptyState
        action={<ButtonLink href={`/campaigns/${campaign.id}/spec`}>Open the spec</ButtonLink>}
        description="The plan is built from the release spec: its capabilities, messaging, and proof."
        icon={DocumentValidationIcon}
        title="Draft the spec first"
      />
    )
  }

  // An earlier version by id; only ids listed for this campaign are accepted.
  const viewed =
    typeof version === 'string' &&
    version !== plans.latest?.id &&
    plans.versions.some((option) => option.id === version)
      ? await getPlanById(access.tenant, campaign.id, version)
      : plans.latest
  // Claim references resolve against the spec version the plan was built from.
  const planSpec =
    !viewed?.specId || viewed.specId === workingSpec.id
      ? workingSpec
      : await getSpecById(access.tenant, viewed.specId).catch(() => null)
  const run = runs.plan
  const runFailed =
    run?.status === 'FAILED' && (!plans.latest || plans.latest.createdAt < run.startedAt)

  return (
    <PlanView
      activeRunId={run?.status === 'RUNNING' ? run.id : null}
      aiConfigured={isCampaignStudioConfigured()}
      campaignId={campaign.id}
      canApprove={campaign.status !== 'ARCHIVED' && accessAllows(access, 'release:approve')}
      canEdit={campaign.status !== 'ARCHIVED' && accessAllows(access, 'release:create')}
      hasApproved={Boolean(plans.approved)}
      productionRun={
        runs.produce?.status === 'RUNNING'
          ? { id: runs.produce.id, startedAt: runs.produce.startedAt.toISOString() }
          : null
      }
      lastRunError={runFailed ? (run.error ?? 'The last plan failed.') : null}
      latestId={plans.latest?.id ?? null}
      plan={
        viewed && {
          changeSummary: viewed.changeSummary,
          content: viewed.content,
          createdAt: viewed.createdAt.toISOString(),
          id: viewed.id,
          origin: viewed.origin,
          specId: viewed.specId,
          status: viewed.status,
          version: viewed.version,
        }
      }
      spec={planSpec && { content: planSpec.content, id: planSpec.id, version: planSpec.version }}
      versions={plans.versions.map((option) => ({
        ...option,
        createdAt: option.createdAt.toISOString(),
      }))}
      workingSpec={{ id: workingSpec.id, version: workingSpec.version }}
    />
  )
}
