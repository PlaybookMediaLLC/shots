'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { ArrowForwardIcon as ArrowRight } from '@/components/platform-shell/icons'
import { ButtonLink } from '@/components/platform-shell/ButtonLink'
import { EmptyState } from '@/components/platform-ui'
import { RecentIcon as Clock3 } from '@/components/platform-shell/icons'
import { GridIcon, MenuIcon as ListIcon } from '@/components/platform-shell/icons'
import { useQuery } from '@tanstack/react-query'
import { useTRPCClient } from '@/lib/trpc/react'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import { Button } from '@/components/ui/button'
import { ProjectPreview } from '@/components/projects/ProjectPreview'
import { cn } from '@/lib/utils'
import { CREATE_TOOLS, publishLinks } from '@/lib/platform/navigation'
import { relativeTime } from '@/components/workflows/workflow-ui'
import { recentWorkQuery, type WorkItem } from './work'

const FILTERS = [
  { label: 'All', type: null },
  { label: 'Releases', type: 'Release', href: '/campaigns/releases' },
  { label: 'Campaigns', type: 'Campaign', href: '/campaigns' },
  {
    label: 'Screenshots',
    type: 'Screenshot',
    href: CREATE_TOOLS.find((tool) => tool.label === 'Screenshot')!.library.href,
  },
  {
    label: 'Canvases',
    type: 'Canvas',
    href: CREATE_TOOLS.find((tool) => tool.label === 'Canvas')!.library.href,
  },
  { label: 'Posts', type: 'Post', href: publishLinks()[0].href },
] as const
type View = 'list' | 'grid'
const VIEW_KEY = 'shots:home-view'
/** The work's kind, with a post's state in the words the drafts list uses. */
const kindLabel = (item: WorkItem) =>
  item.type === 'Post' ? `Post · ${item.status ?? 'Draft'}` : item.type

/** A small picture of the work: its design, or a page with a post's opening words. */
function Thumb({ item, size }: { item: WorkItem; size: 'row' | 'card' }) {
  if (item.type !== 'Screenshot' && item.type !== 'Canvas')
    return (
      <span aria-hidden="true" className={cn('home-page-thumb', size === 'card' && 'is-card')}>
        {size === 'card' && item.excerpt ? (
          <span className="line-clamp-[9] block">{item.excerpt}</span>
        ) : (
          <>
            <span className="w-[80%]" />
            <span className="w-[65%]" />
            <span className="w-[72%]" />
            <span className="w-[45%]" />
          </>
        )}
      </span>
    )
  return (
    <span className={cn('home-design-thumb', size === 'card' && 'is-card')}>
      <ProjectPreview alt="" className="studio-cover" document={item.document ?? null} />
    </span>
  )
}

/** Bounded reads from existing tenant-authorized collections; failures stay visible. */
export function RecentWork({
  campaignsEnabled = false,
  draftsEnabled,
  intro,
  organizationId,
  paidPlan = true,
}: {
  campaignsEnabled?: boolean
  draftsEnabled: boolean
  /** Shown between the filters and the list, as Home's starters are. */
  intro?: ReactNode
  organizationId: string
  /** Without it, screenshots and canvases are a paid feature, so only posts are listed. */
  paidPlan?: boolean
}) {
  const client = useTRPCClient()
  const query = useQuery({
    ...recentWorkQuery(client, organizationId, draftsEnabled, paidPlan, campaignsEnabled),
    // Coming back from an editor shows the last list at once, then adds what was just saved.
    refetchOnMount: 'always',
  })
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['type']>(null)
  const [view, setView] = useState<View>('list')
  // Read after hydration: the server cannot know this browser's choice.
  useEffect(() => {
    try {
      if (localStorage.getItem(VIEW_KEY) === 'grid') setView('grid')
    } catch {
      // Storage blocked: the list view stands.
    }
  }, [])
  const choose = (next: View) => {
    setView(next)
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {
      // Storage blocked: the choice lasts for this visit only.
    }
  }
  // Only the kinds this workspace can have are offered as filters.
  const filters = FILTERS.filter(
    (item) =>
      item.type === null ||
      (item.type === 'Post'
        ? draftsEnabled
        : item.type === 'Release' || item.type === 'Campaign'
          ? paidPlan && campaignsEnabled
          : paidPlan) ||
      query.data?.items.some((work) => work.type === item.type)
  )
  // A filter whose kind is no longer offered falls back to All.
  const active = filters.some((item) => item.type === filter) ? filter : null
  const items = (query.data?.items ?? [])
    .filter((item) => !active || item.type === active)
    .slice(0, 8)
  return (
    <section aria-label="Continue working" className="home-recent">
      <div className="home-recent-bar">
        <div className="platform-tabs" role="group" aria-label="Show">
          {filters.map((item) => (
            <Button
              key={item.label}
              type="button"
              variant="custom"
              size={null}
              aria-pressed={active === item.type}
              className="platform-tab"
              onClick={() => setFilter(item.type)}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <div className="home-view-toggle" role="group" aria-label="Layout">
            <Button
              type="button"
              variant="custom"
              size={null}
              aria-label="Grid view"
              aria-pressed={view === 'grid'}
              onClick={() => choose('grid')}
            >
              <GridIcon size={16} aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="custom"
              size={null}
              aria-label="List view"
              aria-pressed={view === 'list'}
              onClick={() => choose('list')}
            >
              <ListIcon size={16} aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
      {intro ? (
        <>
          {intro}
          <h2 className="home-eyebrow home-divider">Recent</h2>
        </>
      ) : null}
      {query.isPending ? (
        <p role="status" className="py-6 text-sm text-muted-foreground">
          Loading recent work…
        </p>
      ) : null}
      {query.isError || query.data?.partial ? (
        <div
          role="status"
          className="my-3 flex flex-wrap items-center gap-3 rounded-lg border p-3 text-sm"
        >
          <p>Some recent work could not load.</p>
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      ) : null}
      {items.length ? (
        // One list for both layouts, so switching keeps each preview mounted and loaded.
        <ul className={view === 'list' ? 'home-rows' : 'home-cards'}>
          {items.map((item) => (
            <li key={`${item.type}-${item.id}`}>
              <SidebarLink className={view === 'list' ? 'home-row' : 'home-card'} href={item.href}>
                <span className={view === 'grid' ? 'home-card-media' : 'contents'}>
                  <Thumb item={item} size={view === 'list' ? 'row' : 'card'} />
                </span>
                <span className="home-item-text">
                  <span className="block truncate text-[0.875rem] text-foreground">
                    {item.title}
                  </span>
                  <span className="block truncate text-[0.75rem] text-muted-foreground">
                    <span className={view === 'list' ? 'sm:hidden' : undefined}>
                      {kindLabel(item)} ·{' '}
                    </span>
                    <time dateTime={item.updatedAt.toISOString()}>
                      {relativeTime(item.updatedAt.toISOString())}
                    </time>
                  </span>
                </span>
                {view === 'list' ? <span className="home-row-kind">{kindLabel(item)}</span> : null}
              </SidebarLink>
            </li>
          ))}
        </ul>
      ) : null}
      {query.data?.items.length && !items.length ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No {FILTERS.find((item) => item.type === active)?.label.toLowerCase()} in this recent
          list. Open the full collection below to find older work.
        </p>
      ) : null}
      {query.data && !query.data.items.length && !query.data.partial ? (
        <EmptyState
          icon={Clock3}
          title="Your work will appear here"
          description={
            paidPlan && campaignsEnabled
              ? 'Saved releases, campaigns, visuals, and posts appear here.'
              : paidPlan
                ? 'Save a screenshot, canvas, or post to keep everything close at hand.'
                : 'Drafts you write in Publish appear here.'
          }
          action={
            <ButtonLink href={paidPlan ? '/create' : '/publish'}>
              {paidPlan ? 'Create your first visual' : 'Write your first post'}
            </ButtonLink>
          }
        />
      ) : null}
      <p className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        {filters.map((item) =>
          'href' in item && (!active || item.type === active) ? (
            <SidebarLink
              key={item.type}
              href={item.href}
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              View all {item.label.toLowerCase()} <ArrowRight size={12} aria-hidden="true" />
            </SidebarLink>
          ) : null
        )}
        {paidPlan ? (
          <SidebarLink href="/library?type=store" className="hover:text-foreground">
            Store screenshots
          </SidebarLink>
        ) : null}
      </p>
    </section>
  )
}
