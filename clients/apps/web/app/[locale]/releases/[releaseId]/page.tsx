import { ArrowUpRightIcon } from '@phosphor-icons/react/dist/ssr/ArrowUpRight'
import type { Metadata } from 'next'
import { headers } from 'next/headers'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { z } from 'zod'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Group, Page, Pill, type PillTone, Row, Section } from '@/components/platform-ui'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { MediaThumb } from '@/components/write/composer/media-thumb'
import { releaseStatusSchema } from '@/lib/api/contracts/releases'
import { requireActiveOrganizationPermission } from '@/lib/auth/access'
import { requirePaidPageAccess } from '@/lib/auth/page-access'
import { accessAllows } from '@/lib/auth/permissions'
import { getActiveBrand } from '@/lib/launch/store'
import { editorHref } from '@/lib/platform/editor-handoff'
import { getRelease } from '@/lib/tenant/releases'

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
  const screenshots = release.screenshotAssetIds ?? []
  // Each screenshot opens in the editor with the workspace's active brand kit,
  // and its post starts from the release summary (PrepareScreenshotPost).
  // A kit that cannot be read leaves the links working, and the page says so.
  const brand = screenshots.length
    ? await getActiveBrand(tenant).then(
        ({ kitId }) => ({ kitId }),
        () => null
      )
    : { kitId: null }
  const editScreenshot = (assetId: string) =>
    editorHref({ assetId, brandKitId: brand?.kitId ?? undefined }, { releaseId: release.id })
  const status = STATUS[release.status]
  const sources = release.sourceUrls.filter((url) => /^https?:\/\//i.test(url))

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
          <ButtonLink href="/workflows" size="sm" variant="outline">
            Workflows
          </ButtonLink>
        }
      >
        {screenshots.length ? (
          <Section
            title="Screenshots"
            description="Open one in the editor with your brand kit applied, then post it to X and LinkedIn with captions written from this release."
            actions={
              <Link
                className="text-ui text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                href="/library?view=assets"
              >
                Workspace assets
              </Link>
            }
          >
            {brand ? null : (
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
                    data-testid="release-open-editor"
                    href={editScreenshot(assetId)}
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
                        Open in the editor
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
