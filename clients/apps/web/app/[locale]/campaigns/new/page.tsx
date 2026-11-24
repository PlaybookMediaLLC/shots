import type { Metadata } from 'next'
import { CampaignSetupForm } from '@/components/campaigns/CampaignSetupForm'
import { Page } from '@/components/platform-ui'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { accessAllows } from '@/lib/auth/permissions'
import { getRequestId } from '@/lib/auth/access'
import { listProductSurfaces } from '@/lib/tenant/product-surfaces'
import { getRelease } from '@/lib/tenant/releases'
import { headers } from 'next/headers'
import { z } from 'zod'
import { requireCampaignPageAccess } from '../page-access'

export const metadata: Metadata = { title: 'New campaign' }

type NewCampaignPageProps = {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ release?: string }>
}

export default async function NewCampaignPage({ params, searchParams }: NewCampaignPageProps) {
  const [{ locale }, { release: releaseParam }, requestHeaders] = await Promise.all([
    params,
    searchParams,
    headers(),
  ])
  const access = await requireCampaignPageAccess(locale)
  const tenant = {
    organizationId: access.organization.id,
    principal: {
      display: access.session.user.email,
      kind: 'session' as const,
      sessionId: access.session.session.id,
      userId: access.session.user.id,
    },
    requestId: getRequestId(requestHeaders),
  }
  const [surfaces, existingRelease] = await Promise.all([
    listProductSurfaces(tenant),
    releaseParam && z.uuid().safeParse(releaseParam).success
      ? getRelease(tenant, releaseParam).catch(() => null)
      : Promise.resolve(null),
  ])

  return (
    <PlatformShell campaignsEnabled organizationName={access.organization.name}>
      <Page
        description={
          existingRelease
            ? `Starting a campaign from release “${existingRelease.title}”.`
            : 'Tell us what you just shipped. The campaign draft is saved as soon as you submit.'
        }
        title="New campaign"
        width="sm"
      >
        <CampaignSetupForm
          canCreate={accessAllows(access, 'release:create')}
          canManageProducts={accessAllows(access, 'brand:manage')}
          initialRelease={
            existingRelease
              ? {
                  audience: existingRelease.audience ?? '',
                  benefitStatement: existingRelease.benefitStatement,
                  id: existingRelease.id,
                  productSurfaceId: existingRelease.productSurface?.id ?? '',
                  sourceUrls: existingRelease.sourceUrls,
                  title: existingRelease.title,
                }
              : undefined
          }
          surfaces={surfaces.map(({ environment, id, name, url }) => ({
            environment,
            id,
            name,
            url,
          }))}
        />
      </Page>
    </PlatformShell>
  )
}
