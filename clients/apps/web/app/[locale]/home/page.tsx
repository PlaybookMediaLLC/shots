import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { platformHref } from '@/lib/platform/navigation'
import { PlatformShell } from '@/components/platform-shell/PlatformShell'
import { Page } from '@/components/platform-ui'
import { Stage } from '@/components/platform-landing/primitives'
import { ArrowForwardIcon as ArrowRight } from '@/components/platform-shell/icons'
import { OutwardIcon as ArrowUpRight } from '@/components/platform-shell/icons'
import { ImageIcon as ImagePlus } from '@/components/platform-shell/icons'
import { EditIcon as PenLine } from '@/components/platform-shell/icons'
import { CampaignsIcon as Megaphone } from '@/components/platform-shell/icons'
import { AutomateIcon as Workflow } from '@/components/platform-shell/icons'
import { CategoryIcon as Shapes } from '@/components/platform-shell/icons'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { NeedsAttention } from '@/components/platform-hub/NeedsAttention'
import { RecentWork } from '@/components/platform-hub/RecentWork'
import { TemplateHighlights } from '@/components/platform-hub/TemplateBrowser'
import { requirePaidPageAccess, sessionTenant } from '@/lib/auth/page-access'
import type { OrganizationAccess } from '@/lib/auth/access'
import { Suspense } from 'react'
import { hasPermission, normalizeOrganizationRole, type Permission } from '@/lib/auth/permissions'
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
    redirect(platformHref(locale === 'en' ? '/' : `/${locale}`, `/?${search}`))
  }
  // A contract that grants drafts without a paid plan gets Home too; paid starters lead to the plan page.
  const requestHeaders = await headers()
  const access = await requirePaidPageAccess(requestHeaders, locale, '/home', 'content:drafts')
  const paid = access.hasPaidPlan
  const gated = (href: string) => (paid ? href : `/upgrade?from=${encodeURIComponent(href)}`)
  const can = (permission: Permission) => hasPermission(access.role, permission)
  const starters = [
    {
      title: 'Create a visual',
      description: 'Screenshots, mockups, and designs.',
      href: gated('/create'),
      icon: ImagePlus,
      pro: !paid,
      allowed: can('artifact:edit'),
    },
    ...(contentDraftsEnabled()
      ? [
          {
            title: 'Write a post',
            description: 'Draft and schedule your posts.',
            href: '/write',
            icon: PenLine,
            // Makes the draft at once, as New → Post does.
            startsPost: true,
            allowed: can('artifact:edit'),
          },
        ]
      : []),
    ...(access.campaignWorkflowEnabled
      ? [
          {
            title: 'Plan a campaign',
            description: 'Organize your next product launch.',
            href: gated('/campaigns/new'),
            icon: Megaphone,
            pro: !paid,
            allowed: can('release:create'),
          },
        ]
      : []),
    {
      title: 'Build a workflow',
      description: 'Automate repeatable tasks.',
      // Automate opens without a paid plan and says there that its runs need Pro.
      href: '/workflows',
      icon: Workflow,
      pro: !paid,
      allowed: can('workspace:update'),
    },
  ] as {
    title: string
    description: string
    href: string
    icon: typeof Workflow
    pro?: boolean
    startsPost?: boolean
    allowed: boolean
  }[]
  // Starters the role cannot use are left out, and the page says why.
  const available = starters.filter((starter) => starter.allowed)
  return (
    <PlatformShell
      campaignsEnabled={access.campaignWorkflowEnabled}
      organizationName={access.organization?.name}
    >
      <Page
        title="Home"
        description="What will you make today?"
        actions={
          paid ? (
            <ButtonLink href="/library?view=templates" variant="outline" className="gap-2">
              <Shapes size={16} aria-hidden="true" /> Explore templates{' '}
              <ArrowUpRight size={15} aria-hidden="true" />
            </ButtonLink>
          ) : (
            <ButtonLink href="/upgrade" variant="outline" className="gap-2">
              See plans <ArrowUpRight size={15} aria-hidden="true" />
            </ButtonLink>
          )
        }
      >
        <section aria-label="Start something new" className="platform-home">
          {available.length < starters.length ? (
            <p className="mb-3 text-sm text-muted-foreground">
              Your {roleLabels[normalizeOrganizationRole(access.role)]} role can view this
              workspace&apos;s work{available.length ? ' and start what is listed here' : ''}. Ask a
              workspace owner or admin for more access.
            </p>
          ) : null}
          <ul className="home-actions">
            {available.map(({ title, description, href, icon: Icon, pro, startsPost }, index) => {
              const content = (
                <>
                  {/* A small grain stage, like the gallery's covers. */}
                  <Stage className="size-12 shrink-0 rounded-lg" variant={index}>
                    <span className="grid size-7 place-items-center rounded-md bg-[#090909]/90 text-white ring-1 ring-white/10">
                      <Icon size={16} aria-hidden="true" />
                    </span>
                  </Stage>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-ui-lg font-medium text-foreground">
                      {title}
                      {pro ? <span className="platform-pro-badge">Pro</span> : null}
                    </span>
                    <span className="mt-1 block text-[13px] leading-relaxed text-muted-foreground">
                      {description}
                    </span>
                  </span>
                  <ArrowUpRight size={14} aria-hidden="true" className="home-action-arrow" />
                </>
              )
              return (
                <li key={href}>
                  {startsPost ? (
                    <StartPostAction>{content}</StartPostAction>
                  ) : (
                    <SidebarLink href={href} className="home-action group">
                      {content}
                    </SidebarLink>
                  )}
                </li>
              )
            })}
          </ul>
        </section>

        {paid && contentDraftsEnabled() && can('artifact:edit') && access.organization ? (
          <Suspense fallback={null}>
            <UpcomingQueue tenant={sessionTenant(access, access.organization.id, requestHeaders)} />
          </Suspense>
        ) : null}
        <div className="home-work platform-home">
          <RecentWork
            organizationId={access.organization!.id}
            draftsEnabled={contentDraftsEnabled()}
            paidPlan={paid}
          />
          <NeedsAttention />
        </div>

        {paid ? (
          <section aria-labelledby="home-templates" className="platform-home grid gap-4">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-normal tracking-[-0.01em]" id="home-templates">
                  Start from a template
                </h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Finished looks for your next screenshot.
                </p>
              </div>
              <SidebarLink
                href="/library?view=templates"
                className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                All templates <ArrowUpRight size={14} aria-hidden="true" />
              </SidebarLink>
            </div>
            <TemplateHighlights />
          </section>
        ) : null}

        <SidebarLink href={gated('/library?view=brand')} className="platform-home home-brand group">
          <span className="flex items-center gap-3">
            <span className="grid size-8 shrink-0 place-items-center">
              <Shapes size={19} className="text-muted-foreground" aria-hidden="true" />
            </span>
            <span>
              <span className="flex items-center gap-2 text-ui-lg font-medium">
                Brand resources
                {paid ? null : <span className="platform-pro-badge">Pro</span>}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                Manage your brand kit, voice, and products.
              </span>
            </span>
          </span>
          <span className="flex items-center gap-2 text-xs font-medium">
            Manage brand <ArrowRight size={15} aria-hidden="true" />
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
