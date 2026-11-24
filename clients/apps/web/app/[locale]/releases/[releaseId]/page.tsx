import { ArrowUpRightIcon } from '@phosphor-icons/react/dist/ssr/ArrowUpRight'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { z } from 'zod'
import { Suspense } from 'react'
import { ReleaseQualificationSection } from '@/components/releases/ReleaseQualificationSection'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { CampaignStatusPill } from '@/components/campaigns/CampaignStatusPill'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Group, Page, Pill, type PillTone, Row, Section } from '@/components/platform-ui'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { MediaThumb } from '@/components/write/composer/media-thumb'
import { releaseStatusSchema } from '@/lib/api/contracts/releases'
import { requirePaidPageAccess, sessionTenant } from '@/lib/auth/page-access'
import { accessAllows } from '@/lib/auth/permissions'
import { getActiveBrand } from '@/lib/launch/store'
import { editorHref } from '@/lib/platform/editor-handoff'
import { getRelease } from '@/lib/tenant/releases'
import { listCampaigns } from '@/lib/tenant/campaigns'

export const metadata: Metadata = { title: 'Release' }

const STATUS: Record<z.infer<typeof releaseStatusSchema>, { label: string; tone: PillTone }> = {
  ARCHIVED: { label: 'Archived', tone: 'gray' },
  CANCELLED: { label: 'Cancelled', tone: 'red' },
  DRAFT: { label: 'Draft', tone: 'gray' },
  READY: { label: 'Ready', tone: 'green' },
}

/** A source link as a reader scans it: the site, then the rest of the address. */
function sourceParts(url: string): { host: string; rest: string } {
  try {
    const parsed = new URL(url)
    return { host: parsed.host.replace(/^www\./, ''), rest: parsed.pathname + parsed.search }
  } catch {
    return { host: url, rest: '' }
  }
}

/** Read-only source evidence, including releases that have no campaign yet. */
export default async function ReleasePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; releaseId: string }>
  searchParams: Promise<{ campaignCursor?: string }>
}) {
  const [{ locale, releaseId }, { campaignCursor }, requestHeaders] = await Promise.all([
    params,
    searchParams,
    headers(),
  ])
  if (!z.uuid().safeParse(releaseId).success) notFound()
  if (campaignCursor !== undefined && !z.string().cuid().safeParse(campaignCursor).success)
    notFound()
  const access = await requirePaidPageAccess(requestHeaders, locale, `/releases/${releaseId}`)
  if (!access.organization || !accessAllows(access, 'artifact:read')) notFound()
  const tenant = sessionTenant(access, access.organization.id, requestHeaders)
  // Each screenshot opens in the editor with the workspace's active brand kit,
  // and its post starts from the release summary (PrepareScreenshotPost).
  // A kit that cannot be read leaves the links working, and the page says so.
  // Read beside the release rather than after it, which saves a round trip.
  const [release, activeBrand, related] = await Promise.all([
    getRelease(tenant, releaseId),
    getActiveBrand(tenant).then(
      ({ kitId }) => ({ kitId }),
      () => null
    ),
    access.campaignWorkflowEnabled
      ? listCampaigns(tenant, { releaseId, cursor: campaignCursor, limit: 11 }).then(
          (campaigns) => ({ campaigns, error: false }),
          () => ({ campaigns: [], error: true })
        )
      : Promise.resolve({ campaigns: [], error: false }),
  ])
  if (!release) notFound()
  const screenshots = release.screenshotAssetIds ?? []
  const brand = screenshots.length ? activeBrand : { kitId: null }
  const editScreenshot = (assetId: string) =>
    editorHref({ assetId, brandKitId: brand?.kitId ?? undefined }, { releaseId: release.id })
  const status = STATUS[release.status]
  const sources = release.sourceUrls.filter((url) => /^https?:\/\//i.test(url))
  const inactive = release.status === 'ARCHIVED' || release.status === 'CANCELLED'
  const merged = Boolean(release.canonicalReleaseId && release.canonicalReleaseId !== release.id)
  const canCreate =
    access.campaignWorkflowEnabled && accessAllows(access, 'release:create') && !inactive && !merged
  const campaignPage = related.campaigns.slice(0, 10)

  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization.name}
    >
      <Page
        title={release.title}
        width="md"
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Pill tone={status.tone}>{status.label}</Pill>
            <span>
              Updated{' '}
              {release.updatedAt.toLocaleString('en', {
                dateStyle: 'medium',
                timeStyle: 'short',
                timeZone: 'UTC',
              })}{' '}
              UTC
            </span>
            {release.productSurface ? <span>· {release.productSurface.name}</span> : null}
          </span>
        }
        actions={
          <>
            {canCreate ? (
              <ButtonLink href={`/campaigns/new?releaseId=${release.id}`} size="sm">
                Create campaign from this release
              </ButtonLink>
            ) : null}
            <ButtonLink href="/workflows" size="sm" variant="outline">
              Workflows
            </ButtonLink>
          </>
        }
      >
        {merged ? (
          <Section title="This release was merged">
            <p>
              Its saved facts and existing campaigns remain here. Continue new work on the current
              release.
            </p>
            <ButtonLink href={`/releases/${release.canonicalReleaseId}`}>
              Open current release
            </ButtonLink>
          </Section>
        ) : null}
        <Suspense fallback={<p role="status">Loading release facts…</p>}>
          <ReleaseQualificationSection
            tenant={tenant}
            releaseId={release.id}
            userId={access.session.user.id}
            sourceUrls={release.sourceUrls}
            canEdit={accessAllows(access, 'release:create')}
            canDecide={accessAllows(access, 'release:approve')}
            canReadMembers={accessAllows(access, 'member:read')}
            inactive={inactive}
          />
        </Suspense>
        <Section title="Campaigns" description="Continue work created from this release.">
          {!access.campaignWorkflowEnabled ? (
            <p>Campaigns are not enabled for this workspace.</p>
          ) : (
            <>
              {merged ? (
                <p>Existing campaigns keep their original release history.</p>
              ) : inactive ? (
                <p role="status">
                  This release is {status.label.toLowerCase()}. Existing campaigns remain available;
                  restore the release before creating another.
                </p>
              ) : !canCreate ? (
                <p>
                  Your role can view campaigns. Ask a workspace admin for creator access to start
                  one.
                </p>
              ) : null}
              {related.error ? (
                <p role="alert">
                  Campaigns could not load.{' '}
                  <Link className="underline" href={`/releases/${release.id}`}>
                    Try again from the newest campaigns
                  </Link>
                  .
                </p>
              ) : campaignPage.length ? (
                <Group>
                  {campaignPage.map((campaign) => (
                    <Row key={campaign.id}>
                      <Link
                        className="text-ui-lg underline underline-offset-4"
                        href={`/campaigns/${campaign.id}`}
                      >
                        {campaign.name}
                      </Link>
                      <CampaignStatusPill status={campaign.status} />
                    </Row>
                  ))}
                </Group>
              ) : (
                <p>
                  {campaignCursor ? 'No older campaigns.' : 'No campaigns for this release yet.'}
                </p>
              )}
              <div className="flex flex-wrap gap-3">
                {campaignCursor ? (
                  <ButtonLink variant="outline" href={`/releases/${release.id}`}>
                    Newest campaigns
                  </ButtonLink>
                ) : null}
                {related.campaigns.length > 10 ? (
                  <ButtonLink
                    variant="outline"
                    href={`/releases/${release.id}?campaignCursor=${campaignPage[9].id}`}
                  >
                    Older campaigns
                  </ButtonLink>
                ) : null}
              </div>
            </>
          )}
        </Section>
        {screenshots.length ? (
          <Section
            title="Screenshots"
            description={
              merged
                ? 'View the original screenshots. Start new work from the current release linked above.'
                : 'Open one in the editor with your brand kit applied, then post it to X and LinkedIn with captions written from this release.'
            }
            actions={
              <Link
                className="text-ui text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                href="/library?view=assets"
              >
                Workspace assets
              </Link>
            }
          >
            {brand || merged ? null : (
              <p className="text-ui text-muted-foreground" role="status">
                The brand kit could not be read, so screenshots open without it. Apply it from Brand
                in the editor.
              </p>
            )}
            <ul className="grid gap-4 sm:grid-cols-2">
              {screenshots.map((assetId, index) => (
                <li key={assetId}>
                  <Link
                    className="group block overflow-hidden rounded-[14.4px] border border-border bg-[var(--platform-group,var(--card))] transition-colors hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
                    data-testid={merged ? 'release-view-original' : 'release-open-editor'}
                    href={
                      merged
                        ? `/api/v1/assets/${encodeURIComponent(assetId)}/content`
                        : editScreenshot(assetId)
                    }
                    target={merged ? '_blank' : undefined}
                    rel={merged ? 'noopener noreferrer' : undefined}
                  >
                    <span className="relative block aspect-[16/10] overflow-hidden bg-[radial-gradient(circle_at_center,#1a1a1a,#0c0c0c)]">
                      {/* The link's text names it, so the picture adds no words. */}
                      <MediaThumb
                        assetId={assetId}
                        className="absolute inset-0 size-full bg-transparent object-contain p-4 transition-transform duration-300 group-hover:scale-[1.02]"
                        video={false}
                      />
                    </span>
                    <span className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
                      <span className="text-ui-lg text-foreground">
                        {screenshots.length === 1 ? 'Screenshot' : `Screenshot ${index + 1}`}
                      </span>
                      <span className="inline-flex items-center gap-1 text-ui text-muted-foreground transition-colors group-hover:text-foreground">
                        {merged ? 'View original (opens in a new tab)' : 'Open in the editor'}
                        <ArrowUpRightIcon aria-hidden="true" className="size-3.5" />
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <Section title="Brief">
          <Group>
            <Row>
              <p className="text-body leading-relaxed whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
                {release.benefitStatement || 'No brief yet.'}
              </p>
            </Row>
            {release.audience ? (
              <Row label="Audience">
                <span className="text-ui text-muted-foreground">{release.audience}</span>
              </Row>
            ) : null}
          </Group>
        </Section>

        {release.features?.length ? (
          <Section title="Changes">
            <Group>
              <ul className="divide-y divide-[var(--divider,var(--border))]">
                {release.features.map((feature, index) => (
                  <li
                    className="flex min-w-0 items-center justify-between gap-4 px-4 py-3"
                    key={index}
                  >
                    <span className="min-w-0 text-ui-lg text-foreground [overflow-wrap:anywhere]">
                      {feature.title}
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-ui text-muted-foreground">
                      {feature.number ? (
                        <span className="tabular-nums">#{feature.number}</span>
                      ) : null}
                      <Pill>{feature.kind}</Pill>
                    </span>
                  </li>
                ))}
              </ul>
            </Group>
          </Section>
        ) : null}

        {sources.length ? (
          <Section title="Sources">
            <Group>
              {sources.map((url) => {
                const { host, rest } = sourceParts(url)
                return (
                  <a
                    className="group flex min-w-0 items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-foreground/[0.03]"
                    href={url}
                    key={url}
                    rel="noopener noreferrer"
                    target="_blank"
                    title={url}
                  >
                    <span className="min-w-0 truncate text-ui">
                      <span className="text-foreground">{host}</span>
                      <span className="text-muted-foreground">{rest}</span>
                    </span>
                    <ArrowUpRightIcon
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground"
                    />
                  </a>
                )
              })}
            </Group>
          </Section>
        ) : null}

        {release.notes ? (
          <Disclosure className="rounded-[14.4px] border border-border px-4 py-3">
            <DisclosureTrigger>Source notes</DisclosureTrigger>
            <DisclosureContent>
              <pre className="mt-3 font-sans text-ui leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
                {release.notes}
              </pre>
            </DisclosureContent>
          </Disclosure>
        ) : null}
      </Page>
    </PlatformShell>
  )
}
