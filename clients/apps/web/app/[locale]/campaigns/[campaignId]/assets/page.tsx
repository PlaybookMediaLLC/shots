import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import {
  AssetBoard,
  type BoardCapture,
  type BoardVisual,
} from '@/components/launch/assets/AssetBoard'
import { ProduceControl } from '@/components/launch/assets/ProduceControl'
import { CodeHighlights } from '@/components/code-studio/CodeHighlights'
import { isCampaignStudioConfigured } from '@/lib/ai/agents/campaign-studio'
import { critiqueSchema } from '@/lib/ai/launch/critique'
import { accessAllows } from '@/lib/auth/permissions'
import type { TenantContext } from '@/lib/auth/access'
import { latestLaunchRuns } from '@/lib/launch/runs'
import { getCampaignPlans, getReleaseSpecs } from '@/lib/launch/store'
import { createTenantDownloadUrl } from '@/lib/storage/client'
import { getCampaign } from '@/lib/tenant/campaigns'
import { listCampaignDesigns } from '@/lib/tenant/designs'
import { requireCampaignPageAccess } from '../../page-access'

export const metadata: Metadata = { title: 'Campaign assets' }

type CampaignAssetsPageProps = {
  params: Promise<{ campaignId: string; locale: string }>
}

/** A refresh re-signs the private asset URL. */
async function signAssetUrl(tenant: TenantContext, assetId: string): Promise<string | null> {
  try {
    return await createTenantDownloadUrl({ assetId, tenant })
  } catch {
    return null
  }
}

/** The asset board: every plan asset with the designs and product shots made for it. */
export default async function CampaignAssetsPage({ params }: CampaignAssetsPageProps) {
  const { campaignId, locale } = await params
  const access = await requireCampaignPageAccess(locale)
  // Scoped to the active workspace: another workspace's id is a 404.
  const campaign = await getCampaign(access.tenant, campaignId)
  if (!campaign) notFound()
  const [designs, plans, runs, specs] = await Promise.all([
    listCampaignDesigns(access.tenant, campaign.id),
    getCampaignPlans(access.tenant, campaign.id),
    latestLaunchRuns(access.tenant, campaign.id),
    campaign.release ? getReleaseSpecs(access.tenant, campaign.release.id) : null,
  ])
  const plan = plans.approved ?? plans.latest
  const sign = (assetId: string) => signAssetUrl(access.tenant, assetId)
  const captionByAsset = new Map(campaign.assets.map((link) => [link.assetId, link.caption]))

  const [visuals, captures] = await Promise.all([
    Promise.all([
      ...designs.map(async (design): Promise<BoardVisual> => ({
        approvedVariant: design.approvedVariant,
        caption: design.renderedAsset
          ? (captionByAsset.get(design.renderedAsset.id) ?? null)
          : null,
        createdAt: design.createdAt.getTime(),
        critique: critiqueSchema.safeParse(design.critique).data ?? null,
        designId: design.id,
        editHref: `/editor?design=${design.id}`,
        fromEarlierPlan:
          plan && design.planVersion !== null ? design.planVersion !== plan.version : undefined,
        id: design.id,
        image: design.renderedAsset && {
          height: design.renderedAsset.height,
          url: await sign(design.renderedAsset.id),
          width: design.renderedAsset.width,
        },
        name: design.name,
        planAssetKey: design.planAssetKey,
        renderedAssetId: design.renderedAsset?.id ?? null,
        variantLabel: design.variantLabel,
      })),
      ...campaign.assets
        .filter(
          (link) =>
            (link.kind === 'product-shot' || link.kind === 'code-visual') &&
            !designs.some((design) => design.renderedAsset?.id === link.assetId)
        )
        .map(async (link): Promise<BoardVisual> => ({
          approvedVariant: null,
          caption: link.caption,
          createdAt: link.createdAt.getTime(),
          critique: null,
          designId: null,
          editHref: link.kind === 'code-visual' ? '/library?type=code' : `/?asset=${link.asset.id}`,
          fromEarlierPlan:
            plan && link.planVersion !== null ? link.planVersion !== plan.version : undefined,
          id: link.id,
          image: {
            height: link.asset.height,
            url: await sign(link.asset.id),
            width: link.asset.width,
          },
          name: link.kind === 'code-visual' ? 'Code visual' : 'Product shot',
          planAssetKey: link.planAssetKey,
          renderedAssetId: link.asset.id,
          variantLabel: link.variantLabel,
        })),
    ]),
    Promise.all(
      campaign.assets
        .filter((link) => link.kind.startsWith('capture-'))
        .map(async (link): Promise<BoardCapture> => ({
          caption: link.caption,
          device: link.kind === 'capture-mobile' ? 'Mobile' : 'Desktop',
          height: link.asset.height,
          id: link.id,
          url: await sign(link.asset.id),
          width: link.asset.width,
        }))
    ),
  ])

  const canEdit = campaign.status !== 'ARCHIVED' && accessAllows(access, 'release:create')
  const aiConfigured = isCampaignStudioConfigured()
  const produce = runs.produce

  return (
    <div className="flex flex-col gap-10">
      {canEdit ? (
        <ProduceControl
          activeRun={
            produce?.status === 'RUNNING'
              ? { id: produce.id, startedAt: produce.startedAt.toISOString() }
              : null
          }
          blocker={!specs?.latest ? 'spec' : !plan ? 'plan' : !aiConfigured ? 'ai' : null}
          campaignId={campaign.id}
          lastError={produce?.status === 'FAILED' ? produce.error : null}
        />
      ) : null}
      {canEdit ? (
        <CodeHighlights campaignId={campaign.id} sourceUrls={campaign.release?.sourceUrls ?? []} />
      ) : null}
      <AssetBoard
        captures={captures}
        options={{
          aiConfigured,
          campaignId: campaign.id,
          canApprove:
            campaign.status !== 'ARCHIVED' && accessAllows(access, 'release:approve'),
          canEdit,
        }}
        plan={plan?.content ?? null}
        planCreatedAt={plan?.createdAt.getTime() ?? null}
        visuals={visuals}
      />
    </div>
  )
}
