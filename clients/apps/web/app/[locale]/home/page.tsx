import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { platformHref } from '@/lib/platform/navigation'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Page } from '@/components/platform-ui'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { ArrowForwardIcon as ArrowRight, AddIcon as Plus } from '@/components/platform-shell/icons'
import { CategoryIcon as Shapes } from '@/components/platform-shell/icons'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import { SearchField } from '@/components/platform-shell/ShellActions'
import { StarterArt, type StarterKind } from '@/components/platform-hub/StarterArt'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { NeedsAttention } from '@/components/platform-hub/NeedsAttention'
import { RecentWork } from '@/components/platform-hub/RecentWork'
import { requirePaidPageAccess, sessionTenant } from '@/lib/auth/page-access'
import type { OrganizationAccess } from '@/lib/auth/access'
import { Suspense } from 'react'
import { accessAllows, normalizeOrganizationRole, type Permission } from '@/lib/auth/permissions'
import { roleLabels } from '@/lib/auth/role-descriptions'
import { StartPostAction } from '@/components/platform-hub/StartPostAction'
import { QueueNudge } from '@/components/platform-hub/QueueNudge'
import { listContentDraftPostsBetween } from '@/lib/tenant/content-drafts'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'

export const metadata = { title: 'Home' }
export default async function HomePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ locale }, query] = await Promise.all([params, searchParams])
  // Localized legacy editor bookmarks reach this page after locale routing.
  if (['project', 'editor', 'storeProject'].some((key) => query[key] !== undefined)) {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value])
        search.append(key, item)
    }
    redirect(platformHref(locale === 'en' ? '/' : `/${locale}`, `/editor?${search}`))
  }
  // A contract that grants drafts without a paid plan gets Home too; paid starters lead to the plan page.
  const requestHeaders = await headers()
  const access = await requirePaidPageAccess(requestHeaders, locale, '/home', 'content:drafts')
  const paid = access.hasPaidPlan
  // The task study uses this explicit view before changing the default Home.
  const releaseView = query.view === 'release' && paid && access.campaignWorkflowEnabled
  const gated = (href: string) => (paid ? href : `/upgrade?from=${encodeURIComponent(href)}`)
  const can = (permission: Permission) => accessAllows(access, permission)
  const starters = [
    {
      title: 'Create a visual',
      art: 'visual' as StarterKind,
      description: 'Screenshots, mockups, and designs.',
      href: gated('/create'),
      pro: !paid,
      allowed: can('artifact:edit'),
    },
    ...(contentDraftsEnabled()
      ? [
          {
            title: 'Write a post',
            art: 'post' as StarterKind,
            description: 'Draft and schedule your posts.',
            href: '/publish',
            // Makes the draft at once, as New → Post does.
            startsPost: true,
            allowed: can('artifact:edit'),
          },
        ]
      : []),
    ...(access.campaignWorkflowEnabled
      ? [
          {
            title: releaseView ? 'Prepare a release' : 'Plan a campaign',
            art: 'campaign' as StarterKind,
            description: releaseView
              ? 'Describe what changed, then review the campaign brief.'
              : 'Organize your next product launch.',
            href: gated('/campaigns/new'),
            pro: !paid,
            allowed: can('release:create'),
          },
        ]
      : []),
    {
      title: 'Turn releases into campaigns',
      art: 'automate' as StarterKind,
      description: 'Draft a campaign each time you ship.',
      // Automate opens without a paid plan and says there that its runs need Pro.
      href: paid ? '/workflows/new' : '/workflows',
      pro: !paid,
      allowed: can('workspace:update'),
    },
  ] as {
    title: string
    description: string
    href: string
    art: StarterKind
    pro?: boolean
    startsPost?: boolean
    allowed: boolean
  }[]
  // Starters the role cannot use are left out, and the page says why.
  const relevant = releaseView ? starters.filter((starter) => starter.art !== 'automate') : starters
  const available = relevant.filter((starter) => starter.allowed)
  if (releaseView)
    available.sort((a, b) => Number(b.art === 'campaign') - Number(a.art === 'campaign'))
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization?.name}
    >
      <Page
        title="Home"
        description={
          releaseView
            ? 'Prepare communication for a product change, review it, and return to the same saved work.'
            : undefined
        }
        actions={
          <>
            <SearchField />
            {releaseView ? (
              <ButtonLink href={can('release:create') ? '/campaigns/new' : '/campaigns/releases'}>
                {can('release:create') ? 'Prepare a release' : 'Browse releases'}
              </ButtonLink>
            ) : paid ? (
              <ButtonLink
                href="/create"
                className="home-create h-9 gap-1.5 rounded-full px-4 text-[0.8125rem]"
              >
                <Plus size={15} aria-hidden="true" /> Create
              </ButtonLink>
            ) : (
              <ButtonLink href="/upgrade" variant="outline" className="gap-2 rounded-full">
                See plans <ArrowRight size={15} aria-hidden="true" />
              </ButtonLink>
            )}
          </>
        }
      >
        {query.setup === 'unavailable' ? (
          <Alert>
            <AlertTitle>Workspace setup could not be checked</AlertTitle>
            <AlertDescription>
              Your saved settings have not been changed. You can keep working or check again.
              <ButtonLink href="/onboarding/plan" size="sm" variant="outline">
                Check setup again
              </ButtonLink>
            </AlertDescription>
          </Alert>
        ) : null}
        {releaseView ? (
          <>
            <p className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              <SidebarLink href="/campaigns/releases" className="underline underline-offset-4">
                Find an existing release
              </SidebarLink>
              <SidebarLink href="/campaigns" className="underline underline-offset-4">
                Resume a campaign
              </SidebarLink>
              <SidebarLink
                href="/home"
                className="text-muted-foreground underline underline-offset-4"
              >
                Show all starters
              </SidebarLink>
            </p>
            <NeedsAttention />
          </>
        ) : null}
        <RecentWork
          campaignsEnabled={access.campaignWorkflowEnabled}
          organizationId={access.organization!.id}
          draftsEnabled={contentDraftsEnabled()}
          paidPlan={paid}
          intro={
            <section aria-labelledby="home-start" className="home-start">
              <h2 className="home-eyebrow" id="home-start">
                {releaseView
                  ? 'Start with a release, or create something on its own'
                  : 'Start something new'}
              </h2>
              {available.length < relevant.length ? (
                <p className="mb-3 text-sm text-muted-foreground">
                  Your {roleLabels[normalizeOrganizationRole(access.role)]} role can view this
                  workspace&apos;s work{available.length ? ' and start what is listed here' : ''}.
                  Ask a workspace owner or admin for more access.
                </p>
              ) : null}
              <ul className="home-starters">
                {available.map(({ title, description, href, art, pro, startsPost }) => {
                  const content = (
                    <>
                      <span className="home-starter-tile">
                        <StarterArt kind={art} />
                      </span>
                      <span className="home-starter-title">
                        {title}
                        {pro ? <span className="platform-pro-badge">Pro</span> : null}
                      </span>
                      <span className="home-starter-detail">{description}</span>
                    </>
                  )
                  return (
                    <li key={href}>
                      {startsPost ? (
                        <StartPostAction>{content}</StartPostAction>
                      ) : (
                        <SidebarLink href={href} className="home-starter group">
                          {content}
                        </SidebarLink>
                      )}
                    </li>
                  )
                })}
                {paid ? (
                  <li>
                    <SidebarLink href="/create?view=templates" className="home-starter group">
                      <span className="home-starter-tile">
                        <StarterArt kind="templates" />
                      </span>
                      <span className="home-starter-title">Browse all templates</span>
                      <span className="home-starter-detail">
                        Finished looks for your next visual.
                      </span>
                    </SidebarLink>
                  </li>
                ) : null}
              </ul>
            </section>
          }
        />
        {paid && contentDraftsEnabled() && can('artifact:edit') && access.organization ? (
          <Suspense fallback={null}>
            <UpcomingQueue tenant={sessionTenant(access, access.organization.id, requestHeaders)} />
          </Suspense>
        ) : null}
        {!releaseView ? <NeedsAttention /> : null}
        <SidebarLink href={gated('/library?view=brand')} className="platform-home home-brand group">
          <span className="flex items-center gap-3">
            <span className="grid size-8 shrink-0 place-items-center">
              <Shapes size={19} className="text-muted-foreground" aria-hidden="true" />
            </span>
            <span>
              <span className="flex items-center gap-2 text-[0.84375rem] font-medium">
                Brand assets
                {paid ? null : <span className="platform-pro-badge">Pro</span>}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Your logos, colours and fonts, ready for every visual.
              </span>
            </span>
          </span>
          <span className="flex items-center gap-2 text-xs font-medium">
            Open in Library <ArrowRight size={15} aria-hidden="true" />
          </span>
        </SidebarLink>
      </Page>
    </PlatformShell>
  )
}

/**
 * Drafts queued for the next seven days, streamed after the page: Home nudges
 * below three. A failed read is logged and shows nothing.
 */
async function UpcomingQueue({ tenant }: { tenant: OrganizationAccess }) {
  const now = new Date()
  const posts = await listContentDraftPostsBetween(
    tenant,
    now,
    new Date(now.getTime() + 7 * 86_400_000)
  ).catch((error: unknown) => {
    console.error('Home could not read the queue for its nudge', error)
    return null
  })
  if (!posts) return null
  const queued = new Set(
    posts
      .filter((post) => post.status === 'SCHEDULED' || post.status === 'PROCESSING')
      .map((post) => post.draftId)
  ).size
  return queued < 3 ? <QueueNudge queued={queued} /> : null
}
