'use client'

import { SidebarLink as Link } from '@/components/platform-shell/SidebarLink'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const TABS = [
  { label: 'Overview', path: '' },
  { label: 'Brief & evidence', path: '/spec' },
  { label: 'Plan', path: '/plan' },
  { label: 'Visuals', path: '/assets' },
  { label: 'Content & review', path: '/copy' },
] as const

/** Polar-style pill tabs for a campaign's pages. */
export function CampaignSubnav({ campaignId }: { campaignId: string }) {
  // Without a leading locale segment, e.g. /fr/campaigns/… → /campaigns/…
  const pathname = usePathname().replace(/^\/[a-z]{2}(?:-[A-Z]{2})?(?=\/|$)/, '')
  const base = `/campaigns/${campaignId}`
  return (
    <nav
      aria-label="Campaign"
      className="-mt-3 flex gap-1 overflow-x-auto border-b border-foreground/[0.07] pb-3"
    >
      {TABS.map((tab) => {
        const href = base + tab.path
        const active = pathname === href || (tab.path !== '' && pathname.startsWith(`${href}/`))
        return (
          <Link
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex h-8 shrink-0 items-center rounded-full px-3 text-ui-lg font-medium transition-colors',
              active
                ? 'bg-foreground/[0.08] text-foreground'
                : 'text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground'
            )}
            href={href}
            key={tab.label}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
