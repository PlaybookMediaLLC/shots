import type { Metadata } from 'next'
import { CampaignSetupForm } from '@/components/campaigns/CampaignSetupForm'
import { Page } from '@/components/platform-ui'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { accessAllows } from '@/lib/auth/permissions'
import { getRequestId } from '@/lib/auth/access'
import { listProductSurfaces } from '@/lib/tenant/product-surfaces'
import { headers } from 'next/headers'
import { requireCampaignPageAccess } from '../page-access'

export const metadata: Metadata = { title: 'New campaign' }

type NewCampaignPageProps = {
  params: Promise<{ locale: string }>
}

export default async function NewCampaignPage({ params }: NewCampaignPageProps) {
  const { locale } = await params
  const access = await requireCampaignPageAccess(locale)
  const surfaces = await listProductSurfaces({
    organizationId: access.organization.id,
    principal: {
      display: access.session.user.email,
      kind: 'session',
      sessionId: access.session.session.id,
      userId: access.session.user.id,
    },
    requestId: getRequestId(await headers()),
  })

  return (
    <PlatformShell campaignsEnabled organizationName={access.organization.name}>
      <Page
        description="Tell us what you just shipped. The campaign draft is saved as soon as you submit."
        title="New campaign"
        width="sm"
      >
        <CampaignSetupForm
          canCreate={accessAllows(access, 'release:create')}
          canManageProducts={accessAllows(access, 'brand:manage')}
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
