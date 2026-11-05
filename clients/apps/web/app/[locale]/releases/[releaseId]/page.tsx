import type { Metadata } from 'next'
import { headers } from 'next/headers'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { z } from 'zod'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Page, Section } from '@/components/platform-ui'
import { requireActiveOrganizationPermission } from '@/lib/auth/access'
import { requirePaidPageAccess } from '@/lib/auth/page-access'
import { accessAllows } from '@/lib/auth/permissions'
import { getRelease } from '@/lib/tenant/releases'

export const metadata: Metadata = { title: 'Release' }

/** Read-only source evidence, including releases that have no campaign yet. */
export default async function ReleasePage({
  params,
}: {
  params: Promise<{ locale: string; releaseId: string }>
}) {
  const [{ locale, releaseId }, requestHeaders] = await Promise.all([params, headers()])
  if (!z.uuid().safeParse(releaseId).success) notFound()
  const access = await requirePaidPageAccess(requestHeaders, locale, `/releases/${releaseId}`)
  if (!access.organization || !accessAllows(access, 'artifact:read')) notFound()
  const tenant = await requireActiveOrganizationPermission(requestHeaders, 'artifact:read')
  const release = await getRelease(tenant, releaseId)
  if (!release) notFound()

  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <Page
        title={release.title}
        width="md"
        description={`${release.status} · Updated ${release.updatedAt.toLocaleString('en', { timeZone: 'UTC' })} UTC`}
        actions={
          <Link className="text-sm underline" href="/workflows">
            Workflows
          </Link>
        }
      >
        <Section title="Release brief">
          <p className="whitespace-pre-wrap text-sm">{release.benefitStatement}</p>
          {release.audience ? (
            <p className="text-sm text-muted-foreground">Audience: {release.audience}</p>
          ) : null}
        </Section>
        {release.notes ? (
          <Section title="Source notes">
            <pre className="whitespace-pre-wrap break-words font-sans text-sm">{release.notes}</pre>
          </Section>
        ) : null}
        {release.features?.length ? (
          <Section title="Changes">
            <ul className="list-inside list-disc space-y-2 text-sm">
              {release.features.map((feature, index) => (
                <li key={index}>
                  {feature.title}
                  {feature.number ? ` (#${feature.number})` : ''} · {feature.kind}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        {release.sourceUrls.length ? (
          <Section title="Source links">
            <ul className="space-y-2 text-sm">
              {release.sourceUrls
                .filter((url) => /^https?:\/\//i.test(url))
                .map((url) => (
                  <li key={url}>
                    <a
                      className="break-all underline"
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {url}
                    </a>
                  </li>
                ))}
            </ul>
          </Section>
        ) : null}
        {release.screenshotAssetIds?.length ? (
          <p className="text-sm">
            {release.screenshotAssetIds.length} screenshot asset(s) retained.{' '}
            <Link className="underline" href="/library?view=assets">
              Open workspace assets
            </Link>
          </p>
        ) : null}
      </Page>
    </PlatformShell>
  )
}
