'use client'

import { SidebarLink } from '@/components/platform-shell/SidebarLink'
import { Button } from '@/components/ui/button'
import { publishLinks } from '@/lib/platform/navigation'
import { cn } from '@/lib/utils'

const ACTIVE = {
  drafts: 'Posts',
  plan: 'Calendar',
  analyze: 'Analyze',
  links: 'Link checks',
}

const ANALYZE_LINKS = [
  { href: '/publish/analyze', label: 'Overview' },
  { href: '/publish/analyze/posting-times', label: 'Best times and posting slots' },
  { href: '/publish/analyze/observations', label: 'Recorded observations and CSV' },
]

/** The Publish tab bar, pinned in the same place on every Publish page; `scope` keeps the profile. */
export function WorkspaceNav({
  active,
  scope = '',
}: {
  active: keyof typeof ACTIVE
  scope?: string
}) {
  return <TabRow label="Publish" active={ACTIVE[active]} items={publishLinks(scope)} />
}

/** Analyze's own pages, as a second row under the Publish tabs. */
export function AnalyzeNav({ active, scope = '' }: { active: string; scope?: string }) {
  return (
    <TabRow
      label="Analyze"
      active={active}
      items={ANALYZE_LINKS.map((item) => ({ ...item, href: `${item.href}${scope}` }))}
      secondary
    />
  )
}

function TabRow({
  active,
  items,
  label,
  secondary = false,
}: {
  active: string
  items: { href: string; label: string }[]
  label: string
  secondary?: boolean
}) {
  return (
    <nav
      aria-label={label}
      // The expanded sidebar lists Publish's pages, so the shell hides this first row there.
      data-area-tabs={secondary ? undefined : true}
      className={cn(
        'flex shrink-0 gap-1 overflow-x-auto px-3 [scrollbar-width:none]',
        secondary ? 'py-2' : 'border-b border-border py-2'
      )}
    >
      {items.map(({ href, label: name }) => (
        <Button
          asChild
          className={cn(
            'shrink-0 rounded-full',
            name === active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
          )}
          key={name}
          size={secondary ? 'sm' : 'default'}
          variant={name === active ? 'secondary' : 'ghost'}
        >
          <SidebarLink aria-current={name === active ? 'page' : undefined} href={href}>
            {name}
          </SidebarLink>
        </Button>
      ))}
    </nav>
  )
}
