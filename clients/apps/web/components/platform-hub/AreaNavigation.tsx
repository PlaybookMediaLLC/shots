'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import { activeLink, type AreaLink } from '@/lib/platform/navigation'
import { withoutLocale } from '@/lib/settings/appearance'
import { cn } from '@/lib/utils'

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

/** The href of the area link this page is on; see {@link activeLink}. */
export function useActiveAreaLink(items: { href: string }[]): string | undefined {
  const pathname = withoutLocale(usePathname())
  return activeLink(items, pathname, new URLSearchParams(useSearchParams().toString()))?.href
}
