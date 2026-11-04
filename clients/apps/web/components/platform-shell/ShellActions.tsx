'use client'

import { useTranslations } from 'next-intl'
import { AddIcon, SearchIcon } from './icons'
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { usePathname } from 'next/navigation'
import { useNewPost } from '@/components/write/pending-draft'
import { loadWork, recentWorkQuery } from '@/components/platform-hub/work'
import { useTRPCClient } from '@/lib/trpc/react'
import { cn } from '@/lib/utils'
import { useKeys } from '@/components/write/shortcuts'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { roleLabels } from '@/lib/auth/role-descriptions'
import { hasPermission, normalizeOrganizationRole, type Permission } from '@/lib/auth/permissions'
import { Input } from '@/components/ui/input'
import {
  matchesDestination,
  PLATFORM_DESTINATIONS,
  platformArea,
  withPublishAccess,
} from '@/lib/platform/navigation'
import { SidebarLink } from './SidebarLink'

// `permission` is what the destination checks before it creates anything.
// Store screenshots stay on this browser, so any role may make them.
const NEW_ITEMS: { href: string; label: string; paid: boolean; permission?: Permission }[] = [
  { href: '/?start=new', label: 'Screenshot', paid: true, permission: 'artifact:edit' },
  { href: '/canvas/new', label: 'Canvas', paid: true, permission: 'artifact:edit' },
  { href: '/?editor=app-store', label: 'Store screenshots', paid: true },
  { href: '/write', label: 'Post', paid: false, permission: 'artifact:edit' },
  { href: '/campaigns/new', label: 'Campaign', paid: true, permission: 'release:create' },
  { href: '/workflows/new', label: 'Workflow', paid: true, permission: 'workspace:update' },
]

/** Search beside the logo: an icon that opens the command search (⌘K). */
export function SearchButton() {
  const t = useTranslations('platformNavigation')
  const keys = useKeys()
  return (
    <Button
      data-platform-action
      variant="ghost"
      size={null}
      className="touch-hitbox grid size-8 place-items-center rounded-md p-0 text-muted-foreground hover:text-foreground"
      aria-label={t('searchCommands')}
      title={`${t('searchCommands')} (${keys.label({ key: 'k', mod: true })})`}
      onClick={() => window.dispatchEvent(new Event('shots:search'))}
    >
      <SearchIcon className="size-4" aria-hidden="true" />
    </Button>
  )
}

export function ShellActions({
  collapsed,
  campaignsEnabled,
  draftsEnabled,
  draftsPlan = true,
  onNavigate,
  paidPlan = true,
  role,
}: {
  collapsed: boolean
  campaignsEnabled: boolean
  draftsEnabled: boolean
  /** Without content drafts, Post says Pro and opens the plan page instead of a draft that fails. */
  draftsPlan?: boolean
  onNavigate?: () => void
  /** Without it, paid items say Pro and open the plan page instead of bouncing. */
  paidPlan?: boolean
  /** Items the role may not create are shown unavailable, with who can grant access. */
  role: string
}) {
  const t = useTranslations('platformNavigation')
  const newPost = useNewPost(onNavigate)
  const items = NEW_ITEMS.filter(
    (item) =>
      (campaignsEnabled || item.label !== 'Campaign') && (draftsEnabled || item.label !== 'Post')
  )
  const allowed = (item: (typeof NEW_ITEMS)[number]) =>
    !item.permission || hasPermission(role, item.permission)
  const locked = (item: (typeof NEW_ITEMS)[number]) =>
    item.label === 'Post' ? !draftsPlan : item.paid && !paidPlan
  const unavailable = items.filter((item) => !allowed(item))
  return (
    <div className="grid gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            data-platform-action
            variant="custom"
            size={null}
            className={cn(
              // A secondary button: the page keeps the one primary action.
              'flex h-8 w-full items-center justify-start gap-2 rounded-md border border-border px-3 text-ui font-medium text-foreground transition-colors hover:bg-foreground/[0.04]',
              collapsed && 'mx-auto size-8 justify-center px-0'
            )}
            aria-label={t('new')}
          >
            <AddIcon className="size-4" aria-hidden="true" />
            {!collapsed ? t('new') : null}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="platform-overlay min-w-52"
          collisionPadding={12}
        >
          {items.map((item) =>
            !allowed(item) ? (
              <DropdownMenuItem disabled key={item.href}>
                {item.label}
              </DropdownMenuItem>
            ) : item.label === 'Post' && !locked(item) ? (
              <DropdownMenuItem key={item.href} onSelect={newPost}>
                {item.label}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem key={item.href} asChild>
                {locked(item) ? (
                  <SidebarLink
                    aria-label={`${item.label} (Pro)`}
                    href={`/upgrade?from=${encodeURIComponent(item.href)}`}
                    onClick={onNavigate}
                  >
                    {item.label}
                    <span aria-hidden="true" className="platform-pro-badge ms-auto">
                      Pro
                    </span>
                  </SidebarLink>
                ) : (
                  <SidebarLink href={item.href} onClick={onNavigate}>
                    {item.label}
                  </SidebarLink>
                )}
              </DropdownMenuItem>
            )
          )}
          {unavailable.length ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="max-w-60 text-xs font-normal text-muted-foreground">
                Not available to your {roleLabels[normalizeOrganizationRole(role)]} role:{' '}
                {unavailable.map((item) => item.label).join(', ')}. Ask a workspace owner or admin
                for access.
              </DropdownMenuLabel>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** One shortcut listener owns the shell, including when the mobile menu is open. */
export function ShellSearch({
  campaignsEnabled,
  draftsEnabled,
  paidPlan,
  workspaceId,
}: {
  campaignsEnabled: boolean
  draftsEnabled: boolean
  /** Screenshots and canvases are a paid feature; without it only posts are searched. */
  paidPlan: boolean
  /** The workspace this page shows, so its recent work is shared with Home's. */
  workspaceId?: string
}) {
  const t = useTranslations('platformNavigation')
  const pathname = usePathname()
  const client = useTRPCClient()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const launcher = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const show = () => {
      if (
        platformArea(pathname) === 'publish' &&
        document.querySelector('[data-testid="write-frame"]')
      ) {
        window.dispatchEvent(new Event('shots:search-write'))
        return
      }
      launcher.current = document.activeElement as HTMLElement | null
      setQuery('')
      setOpen(true)
    }
    const key = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.altKey ||
        event.key.toLowerCase() !== 'k'
      )
        return
      event.preventDefault()
      event.stopImmediatePropagation()
      show()
    }
    window.addEventListener('keydown', key, true)
    window.addEventListener('shots:search', show)
    return () => {
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('shots:search', show)
    }
  }, [pathname])
  const items = PLATFORM_DESTINATIONS.filter(
    (item) =>
      (campaignsEnabled || item.key !== 'campaigns') &&
      matchesDestination(item.key, t(item.key), query)
  ).map((item) => withPublishAccess(item, draftsEnabled))
  const searchesWork = draftsEnabled || paidPlan
  // Work is found by its name or words too, a moment after typing stops.
  const [term, setTerm] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setTerm(query.trim()), 200)
    return () => clearTimeout(timer)
  }, [query])
  const searching = term.length >= 2
  // An empty box offers the work the person was last on, as Home does.
  const recent = useQuery({
    ...recentWorkQuery(client, workspaceId ?? '', draftsEnabled, paidPlan),
    enabled: open && searchesWork && Boolean(workspaceId) && !query.trim(),
  })
  const found = useQuery({
    enabled: open && searchesWork && searching,
    queryKey: ['shell-search', workspaceId, term, draftsEnabled, paidPlan],
    queryFn: ({ signal }) =>
      loadWork(client, { draftsEnabled, limit: 4, paidPlan, search: term, signal }),
  })
  const work = !query.trim() ? recent : searching ? found : null
  const workItems = (work?.data?.items ?? []).slice(0, 6)
  // A failure stays a failure: the dialog says what could not be searched, not that nothing matched.
  const failed = Boolean(work && (work.isError || work.data?.partial))
  const kinds = new Intl.ListFormat('en', { type: 'conjunction' }).format([
    ...(draftsEnabled ? ['posts'] : []),
    ...(paidPlan ? ['screenshots', 'canvases'] : []),
  ])
  const link = 'min-h-11 justify-between rounded-lg font-normal'
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        // Pinned near the top, so the box stays put as results come and go.
        className="platform-overlay top-[12dvh] max-h-[calc(88dvh-1rem)] w-[calc(100%-2rem)] max-w-xl translate-y-0 gap-5 overflow-y-auto rounded-2xl p-5 sm:max-w-xl sm:p-6"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          launcher.current?.focus()
        }}
      >
        <DialogHeader className="text-start">
          <DialogTitle>{t('searchCommands')}</DialogTitle>
          <DialogDescription>
            This workspace · Places{kinds ? `, plus ${kinds} by name or words` : ''}
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Search destinations"
          placeholder={
            searchesWork
              ? 'Go to a place or find your work… try billing or a post’s words'
              : 'Go to… try screenshot or billing'
          }
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <nav aria-label="Search results" className="grid max-h-[50dvh] gap-1 overflow-y-auto">
          {!query.trim() && workItems.length ? (
            <p className="px-3 pt-1 text-xs text-muted-foreground">Recent work</p>
          ) : null}
          {!query.trim()
            ? workItems.map((item) => (
                <Button asChild className={link} key={`${item.type}-${item.id}`} variant="ghost">
                  <SidebarLink href={item.href} onClick={() => setOpen(false)}>
                    <span className="min-w-0 truncate">{item.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{item.type}</span>
                  </SidebarLink>
                </Button>
              ))
            : null}
          {!query.trim() && workItems.length ? (
            <p className="px-3 pt-3 text-xs text-muted-foreground">Places</p>
          ) : null}
          {items.map((item) => (
            <Button asChild className={link} key={item.key} variant="ghost">
              <SidebarLink href={item.href} onClick={() => setOpen(false)}>
                {t(item.key)}
                <span className="shrink-0 text-xs text-muted-foreground">Destination</span>
              </SidebarLink>
            </Button>
          ))}
          {query.trim()
            ? workItems.map((item) => (
                <Button asChild className={link} key={`${item.type}-${item.id}`} variant="ghost">
                  <SidebarLink href={item.href} onClick={() => setOpen(false)}>
                    <span className="min-w-0 truncate">{item.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{item.type}</span>
                  </SidebarLink>
                </Button>
              ))
            : null}
          {failed ? (
            <p role="status" className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              {searching
                ? 'Some work could not be searched right now.'
                : 'Some recent work could not load.'}
              <Button onClick={() => void work?.refetch()} size="sm" variant="outline">
                Try again
              </Button>
            </p>
          ) : null}
          {query.trim() && !items.length && !workItems.length && !failed ? (
            <p role="status" className="p-3 text-sm text-muted-foreground">
              {searchesWork && (!searching || found.isFetching)
                ? 'Searching…'
                : searchesWork
                  ? `Nothing matches. Search finds places in Shots and ${kinds} by name or words.`
                  : 'No destinations match. Search finds places in Shots, not the work inside them.'}
            </p>
          ) : null}
        </nav>
      </DialogContent>
    </Dialog>
  )
}
