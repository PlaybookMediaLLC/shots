'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import type { PlatformArea } from '@/lib/platform/navigation'
import { withoutLocale } from '@/lib/settings/appearance'
import { cn } from '@/lib/utils'

/** One page of an area, as a link. */
export type AreaLink = { href: string; label: string }

/**
 * Route tabs preserve browser navigation and distinguish links from in-page tabs.
 * The expanded sidebar lists the same pages, so the shell hides these tabs there.
 */
export function AreaNavigation({ label, items }: { label: string; items: AreaLink[] }) {
  const active = useActiveAreaLink(items)
  return (
    <nav aria-label={label} className="platform-tabs" data-area-tabs>
      {items.map((item) => {
        const isActive = item.href === active
        return (
          <SidebarLink
            data-platform-tab
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'platform-tab',
              isActive
                ? 'font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
            key={item.href}
            href={item.href}
          >
            {item.label}
          </SidebarLink>
        )
      })}
    </nav>
  )
}

/** Polar's sub-pages: the active area's pages under its sidebar row, on a hairline. */
export function AreaSubNav({
  items,
  label,
  onNavigate,
}: {
  items: AreaLink[]
  label: string
  onNavigate?: () => void
}) {
  const active = useActiveAreaLink(items)
  return (
    <nav aria-label={label} className="my-2 ms-4 grid gap-2 border-s border-border ps-4">
      {items.map((item) => (
        <SidebarLink
          aria-current={item.href === active ? 'page' : undefined}
          className={cn(
            'text-ui-lg font-medium transition-colors',
            item.href === active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
          )}
          href={item.href}
          key={item.href}
          onClick={onNavigate}
        >
          {item.label}
        </SidebarLink>
      ))}
    </nav>
  )
}

/**
 * The href of the area link this page is on: its path and query match, a link
 * without a query only wins when no more specific sibling matches, and failing
 * both, the link to this path.
 */
export function useActiveAreaLink(items: { href: string }[]): string | undefined {
  const currentPath = withoutLocale(usePathname())
  const pathname =
    currentPath === '/projects' || currentPath === '/assets' ? '/library' : currentPath
  const searchParams = useSearchParams()
  const params = new URLSearchParams(searchParams.toString())
  if (currentPath === '/assets') params.set('view', 'assets')
  const matches = (href: string) => {
    const [path, query] = href.split('?')
    return (
      pathname === path &&
      [...new URLSearchParams(query)].every(([key, value]) => params.get(key) === value)
    )
  }
  return (
    items.find((item) => item.href.includes('?') && matches(item.href)) ??
    items.find((item) => matches(item.href)) ??
    // A link that only carries context, like Link checks' return path, still marks its page.
    items.find((item) => item.href.split('?')[0] === pathname)
  )?.href
}

/** One row of Library categories: each kind of project, then reusable resources. */
export const LIBRARY_LINKS = [
  { href: '/library', label: 'Screenshots' },
  { href: '/library?type=canvas', label: 'Canvas' },
  { href: '/library?type=story', label: 'Story Sets' },
  { href: '/library?type=store', label: 'Store screenshots' },
  { href: '/library?view=assets', label: 'Assets' },
  { href: '/library?view=templates', label: 'Templates' },
  { href: '/library?view=brand', label: 'Brand resources' },
]
export const CAMPAIGN_LINKS = [
  { href: '/campaigns', label: 'Campaigns' },
  { href: '/campaigns/releases', label: 'Release inbox' },
  { href: '/campaigns?status=ARCHIVED', label: 'Archived' },
]
export const AUTOMATE_LINKS = [
  { href: '/workflows/deployments', label: 'Deployments' },
  { href: '/workflows', label: 'Workflows' },
  { href: '/workflows/runs', label: 'Runs' },
  { href: '/workflows?view=sources', label: 'Sources' },
]
export const CREATE_LINKS = [
  { href: '/create', label: 'Start' },
  { href: '/library', label: 'Recent' },
  { href: '/create?view=templates', label: 'Templates' },
  { href: '/create?view=tools', label: 'Tools' },
]

/**
 * Each area's pages, for the sidebar and the page tabs. Publish's pages carry
 * the publishing brand, so they come from `publishLinks` instead.
 */
export const AREA_LINKS: Partial<Record<PlatformArea, AreaLink[]>> = {
  automate: AUTOMATE_LINKS,
  campaigns: CAMPAIGN_LINKS,
  create: CREATE_LINKS,
  library: LIBRARY_LINKS,
}
