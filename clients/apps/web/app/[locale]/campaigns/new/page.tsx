import type { Metadata } from 'next'
import { CampaignSetupForm } from '@/components/campaigns/CampaignSetupForm'
import { Page } from '@/components/platform-ui'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { accessAllows } from '@/lib/auth/permissions'
import { listProductSurfaces } from '@/lib/tenant/product-surfaces'
import { getRelease } from '@/lib/tenant/releases'
import { notFound } from 'next/navigation'
import { z } from 'zod'
import { requireCampaignPageAccess } from '../page-access'

export const metadata: Metadata = { title: 'New campaign' }

type NewCampaignPageProps = {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ releaseId?: string }>
}

export default async function NewCampaignPage({ params, searchParams }: NewCampaignPageProps) {
  const [{ locale }, { releaseId }] = await Promise.all([params, searchParams])
  const access = await requireCampaignPageAccess(locale)
  if (releaseId !== undefined && !z.uuid().safeParse(releaseId).success) notFound()
  const release = releaseId ? await getRelease(access.tenant, releaseId) : null
  if (releaseId && !release) notFound()
  const inactive = release?.status === 'ARCHIVED' || release?.status === 'CANCELLED'
  const surfaces = release
    ? []
    : await listProductSurfaces({
        ...access.tenant,
        principal: {
          kind: 'session',
          display: access.session.user.email,
          sessionId: access.session.session.id,
          userId: access.session.user.id,
        },
      })

  return (
    <PlatformShell campaignsEnabled organizationName={access.organization.name}>
      <Page
        description={
          release
            ? `From release: ${release.title}`
            : 'Tell us what you just shipped. The campaign draft is saved as soon as you submit.'
        }
        actions={
          release ? (
            <ButtonLink href={`/releases/${release.id}`} variant="outline">
              Back to release
            </ButtonLink>
          ) : undefined
        }
        title="New campaign"
        width="sm"
      >
        {inactive ? (
          <p role="status">
            Restore this archived or cancelled release before creating a campaign.
          </p>
        ) : (
          <CampaignSetupForm
            canCreate={accessAllows(access, 'release:create')}
            canManageProducts={accessAllows(access, 'brand:manage')}
            release={
              release
                ? {
                    id: release.id,
                    title: release.title,
                    benefitStatement: release.benefitStatement,
                    audience: release.audience,
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
        )}
      </Page>
    </PlatformShell>
  )
}
