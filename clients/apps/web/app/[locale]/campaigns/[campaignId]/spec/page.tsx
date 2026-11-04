import { SealCheckIcon as DocumentValidationIcon } from '@phosphor-icons/react/dist/ssr/SealCheck'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { SpecEditor } from '@/components/launch/spec/SpecEditor'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { EmptyState } from '@/components/platform-ui'
import { isCampaignStudioConfigured } from '@/lib/ai/agents/campaign-studio'
import { accessAllows } from '@/lib/auth/permissions'
import { latestLaunchRuns } from '@/lib/launch/runs'
import { getReleaseSpecs, getSpecById } from '@/lib/launch/store'
import { getCampaign } from '@/lib/tenant/campaigns'
import { requireCampaignPageAccess } from '../../page-access'

export const metadata: Metadata = { title: 'Campaign spec' }

type SpecPageProps = {
  params: Promise<{ campaignId: string; locale: string }>
  searchParams: Promise<{ version?: string | string[] }>
}

export default async function SpecPage({ params, searchParams }: SpecPageProps) {
  const [{ campaignId, locale }, { version }] = await Promise.all([params, searchParams])
  const access = await requireCampaignPageAccess(locale)
  const campaign = await getCampaign(access.tenant, campaignId)
  if (!campaign) notFound()
  const release = campaign.release
  if (!release) {
    return (
      <EmptyState
        action={
          <ButtonLink href={`/campaigns/${campaign.id}`} variant="outline">
            Back to overview
          </ButtonLink>
        }
        description="The spec is drafted from the release brief and its sources."
        icon={DocumentValidationIcon}
        title="Link a release brief first"
      />
    )
  }

  const [specs, runs] = await Promise.all([
    getReleaseSpecs(access.tenant, release.id),
    latestLaunchRuns(access.tenant, campaign.id),
  ])
  // An earlier version by id; only ids listed for this release are accepted.
  const viewed =
    typeof version === 'string' &&
    version !== specs.latest?.id &&
    specs.versions.some((option) => option.id === version)
      ? await getSpecById(access.tenant, version)
      : specs.latest
  const run = runs.spec
  // A failure matters until a newer version is saved.
  const runFailed =
    run?.status === 'FAILED' && (!specs.latest || specs.latest.createdAt < run.startedAt)

  return (
    <SpecEditor
      activeRunId={run?.status === 'RUNNING' ? run.id : null}
      aiConfigured={isCampaignStudioConfigured()}
      brief={[
        release.title,
        release.benefitStatement,
        release.description,
        release.audience && `Audience: ${release.audience}`,
      ]
        .filter(Boolean)
        .join('\n\n')}
      campaignId={campaign.id}
      canApprove={campaign.status !== 'ARCHIVED' && accessAllows(access, 'release:approve')}
      canEdit={campaign.status !== 'ARCHIVED' && accessAllows(access, 'release:create')}
      lastRunError={runFailed ? (run.error ?? 'The last draft failed.') : null}
      latestId={specs.latest?.id ?? null}
      spec={
        viewed && {
          changeSummary: viewed.changeSummary,
          content: viewed.content,
          createdAt: viewed.createdAt.toISOString(),
          id: viewed.id,
          origin: viewed.origin,
          // Older snapshots may predate fields the schema defaults.
          sources: viewed.sources.map((source) => ({
            ...source,
            flags: source.flags ?? [],
            sections: source.sections ?? [],
            statusReason: source.statusReason ?? '',
          })),
          status: viewed.status,
          version: viewed.version,
        }
      }
      versions={specs.versions.map((option) => ({
        ...option,
        createdAt: option.createdAt.toISOString(),
      }))}
    />
  )
}
