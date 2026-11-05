'use client'

import { publicImageUrl } from '@/lib/assets/public-image'
import { accessAllows } from '@/lib/auth/permissions'

import {
  ActivityIcon,
  AutomateIcon,
  CampaignsIcon,
  ChevronDownIcon,
  CreateIcon,
  HomeIcon,
  LibraryIcon,
  MenuIcon,
  OutwardIcon,
  PublishIcon,
  SettingsIcon,
  SidebarIcon,
  StoreIcon,
} from './icons'
import {
  AREA_LINKS,
  automateLinks,
  type AreaLink,
  areaLocked,
  campaignLinks,
  PLATFORM_DESTINATIONS,
  platformArea,
  publishLinks,
  STORE_SCREENSHOTS,
  withPublishAccess,
} from '@/lib/platform/navigation'
import { AreaSubNav, useActiveAreaLink } from '@/components/platform-hub/AreaNavigation'
import { SearchButton, ShellActions, ShellSearch } from './ShellActions'
import Image from 'next/image'
import { useTranslations } from 'next-intl'
import { usePathname } from 'next/navigation'
import { Suspense, useCallback, useState, useSyncExternalStore } from 'react'
import { NotificationCenter } from '@/components/notifications/NotificationCenter'
import { AccountMenu } from '@/components/auth/AccountMenu'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useHydratedSession } from '@/lib/auth/client'
import { cn } from '@/lib/utils'
import { usePreferences } from '@/components/settings/PreferencesProvider'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { DYNAMIC_NAVIGATION_QUERY } from '@/lib/settings/appearance'
import type { navigationLayoutSchema } from '@/lib/api/contracts/settings-platform'
import type { z } from 'zod'
import { surface } from './shell-config'
import { Button } from '@/components/ui/button'
import { NavRow, type NavIcon } from './NavRow'
import { ProductTourMenu } from './ProductTour'
import { SidebarLink } from './SidebarLink'
import { SettingsNav } from '@/components/settings/SettingsNav'
import { RememberVisits } from './PageVisits'
import { ThemeToggle } from './ThemeToggle'

type NavItem = {
  href: string
  icon: NavIcon
  label: string
  key: (typeof PLATFORM_DESTINATIONS)[number]['key']
}

const ICONS = {
  home: HomeIcon,
  create: CreateIcon,
  campaigns: CampaignsIcon,
  publish: PublishIcon,
  library: LibraryIcon,
  automate: AutomateIcon,
  activity: ActivityIcon,
  settings: SettingsIcon,
}
const withIcons = (items: readonly (typeof PLATFORM_DESTINATIONS)[number][]) =>
  items.map((item) => ({ ...item, icon: ICONS[item.key] }))
type NavGroup = { items: ReturnType<typeof withIcons>; label?: string }
const AREAS_GROUP: NavGroup = { items: withIcons(PLATFORM_DESTINATIONS.slice(0, 6)) }
const WORKSPACE_GROUP: NavGroup = {
  items: withIcons(PLATFORM_DESTINATIONS.slice(6)),
  label: 'Workspace',
}

function NavLink({
  collapsed,
  item: { href, icon, key },
  locked,
  onNavigate,
  subs,
}: {
  collapsed: boolean
  item: NavItem
  /** The plan does not include the area: it is marked Pro and opens the plan page. */
  locked: boolean
  onNavigate?: () => void
  /** The area's pages, listed under the row while the area is open (Polar's NavList). */
  subs?: AreaLink[]
}) {
  const t = useTranslations('platformNavigation')
  const pathname = usePathname()
  const active = platformArea(pathname) === platformArea(href)
  const listed = active && subs && !collapsed && !locked
  // Store screenshots is pinned under Create; when it is the page, Create is its section.
  const pinned = key === 'create' && !locked && !listed
  const storeActive = useActiveAreaLink([STORE_SCREENSHOTS]) === STORE_SCREENSHOTS.href
  return (
    <>
      <NavRow
        active={active}
        badge={
          locked ? (
            <span aria-hidden="true" className="platform-pro-badge ms-auto">
              Pro
            </span>
          ) : null
        }
        collapsed={collapsed}
        // Locked areas open the plan page directly instead of bouncing off a server redirect.
        href={locked ? `/upgrade?from=${encodeURIComponent(href)}` : href}
        icon={icon}
        label={t(key)}
        name={locked ? `${t(key)} (Pro)` : undefined}
        onNavigate={onNavigate}
        section={Boolean(listed) || (pinned && storeActive)}
        tourId={`nav-${key}`}
      />
      {listed ? (
        <AreaSubNav items={subs} label={t(key)} onNavigate={onNavigate} />
      ) : pinned ? (
        <StoreScreenshotsLink
          active={storeActive}
          collapsed={collapsed}
          label={t(key)}
          onNavigate={onNavigate}
        />
      ) : null}
    </>
  )
}

/** Store screenshots stays pinned under Create, one click from every page and in the icon rail. */
function StoreScreenshotsLink({
  active,
  collapsed,
  label,
  onNavigate,
}: {
  active: boolean
  collapsed: boolean
  label: string
  onNavigate?: () => void
}) {
  return collapsed ? (
    <NavRow
      active={active}
      collapsed
      href={STORE_SCREENSHOTS.href}
      icon={StoreIcon}
      label={STORE_SCREENSHOTS.label}
      onNavigate={onNavigate}
    />
  ) : (
    <AreaSubNav items={[STORE_SCREENSHOTS]} label={label} onNavigate={onNavigate} />
  )
}

function Navigation({
  campaignsEnabled,
  collapsed,
  deniedPermissions,
  draftsEnabled,
  draftsPlan,
  onNavigate,
  paidPlan,
  role,
}: {
  campaignsEnabled: boolean
  collapsed: boolean
  deniedPermissions: readonly string[]
  draftsEnabled: boolean
  draftsPlan: boolean
  onNavigate?: () => void
  paidPlan: boolean
  role: string
}) {
  const t = useTranslations('platformNavigation')
  // As in Polar, settings swap the destinations for their own sections.
  if (platformArea(usePathname()) === 'settings') {
    return <SettingsNav collapsed={collapsed} onNavigate={onNavigate} />
  }
  const navGroup = (group: NavGroup) => (
    <div className="grid gap-0.5">
      {group.label && !collapsed ? (
        <p className="platform-eyebrow mb-1 px-3">{t('workspace')}</p>
      ) : null}
      {group.items
        .filter((item) => campaignsEnabled || item.href !== '/campaigns')
        .map((item) => withPublishAccess(item, draftsEnabled))
        .map((item) => (
          <NavLink
            collapsed={collapsed}
            item={item}
            key={item.href}
            locked={areaLocked(item.key, { draftsEnabled, draftsPlan, paidPlan })}
            onNavigate={onNavigate}
            subs={
              item.key === 'publish'
                ? draftsEnabled
                  ? publishLinks()
                  : undefined
                : item.key === 'campaigns'
                  ? campaignLinks(draftsEnabled)
                  : item.key === 'automate'
                    ? automateLinks(accessAllows({ deniedPermissions, role }, 'workspace:update'))
                    : AREA_LINKS[item.key]
            }
          />
        ))}
    </div>
  )
  return (
    <nav aria-label={t('workspace')} className="flex h-full min-h-0 flex-col gap-3">
      {/* Only the areas scroll, so Activity and Settings are never cut off on a short window.
          The fade says there is more below; the padding clears it at rest. */}
      <div className="flex min-h-24 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain pb-6 [mask-image:linear-gradient(to_bottom,black_calc(100%-1.5rem),transparent)]">
        <ShellActions
          collapsed={collapsed}
          campaignsEnabled={campaignsEnabled}
          draftsEnabled={draftsEnabled}
          draftsPlan={draftsPlan}
          onNavigate={onNavigate}
          paidPlan={paidPlan}
          deniedPermissions={deniedPermissions}
          role={role}
        />
        {navGroup(AREAS_GROUP)}
      </div>
      <div className="shrink-0">{navGroup(WORKSPACE_GROUP)}</div>
    </nav>
  )
}

/**
 * Polar's footer switcher: the workspace's mark and name with the signed-in
 * email under it. One menu holds workspace switching and the account.
 */
function WorkspaceSwitcher({
  collapsed,
  organizationName,
}: {
  collapsed: boolean
  organizationName: string
}) {
  const { data: session } = useHydratedSession()
  return (
    <AccountMenu
      workspaceName={organizationName}
      align={collapsed ? 'end' : 'start'}
      side={collapsed ? 'right' : 'top'}
      triggerClassName={cn(
        'flex h-11 w-full min-w-0 items-center gap-2.5 rounded-xl px-2 text-start transition-colors hover:bg-foreground/[0.05]',
        collapsed && 'mx-auto size-10 justify-center px-0'
      )}
    >
      <span
        aria-hidden="true"
        className="grid size-7 shrink-0 place-items-center rounded-lg bg-foreground text-xs font-medium text-background"
      >
        {organizationName.trim().charAt(0).toUpperCase() || 'W'}
      </span>
      {collapsed ? null : (
        <>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ui-lg font-medium text-foreground">
              {organizationName}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {session?.user.email ?? 'Account'}
            </span>
          </span>
          <ChevronDownIcon
            className="shrink-0 text-muted-foreground"
            size={16}
            aria-hidden="true"
          />
        </>
      )}
    </AccountMenu>
  )
}

/** Polar's plan card: a workspace without a plan, and the way up. */
function PlanCard() {
  return (
    <div className="rounded-xl border border-border bg-card p-3.5">
      <p className="text-sm text-foreground">No plan yet</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Pro opens Publish, Create, Library, Campaigns and Automate.
      </p>
      <SidebarLink
        className="mt-2 inline-block text-xs font-medium text-foreground underline underline-offset-4"
        href="/upgrade"
      >
        Upgrade
      </SidebarLink>
    </div>
  )
}

/** The footer: plan card, help and display controls, then the switcher. */
function SidebarFooter({
  collapsed,
  navigation,
  organizationName,
  paidPlan,
}: {
  collapsed: boolean
  navigation?: { expanded: boolean; ready: boolean; setTemporary: (value: boolean) => void }
  organizationName: string
  paidPlan: boolean
}) {
  const t = useTranslations('platformNavigation')
  // As in Polar, the settings sidebar drops the plan card and the docs link.
  const settings = platformArea(usePathname()) === 'settings'
  return (
    <div
      className={cn(
        'mt-3 grid w-full min-w-0 shrink-0 grid-cols-[minmax(0,1fr)] gap-2',
        // In development, room for the Next.js dev badge, which otherwise
        // sits on the switcher and swallows clicks.
        process.env.NODE_ENV === 'development' && 'mb-12'
      )}
    >
      {!collapsed && !paidPlan && !settings ? <PlanCard /> : null}
      <div
        className={cn(
          'flex items-center gap-0.5',
          collapsed ? 'flex-col' : 'ps-2.5',
          settings && 'justify-end'
        )}
      >
        {collapsed || settings ? null : (
          // The docs open beside the app, so reading them never leaves your work.
          <a
            className="me-auto flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            href="/docs"
            rel="noopener"
            target="_blank"
          >
            Documentation <OutwardIcon aria-hidden="true" size={14} />
          </a>
        )}
        {/* The settings sidebar lists its own sections, not the places the tours show. */}
        {settings ? null : <ProductTourMenu />}
        <ThemeToggle />
        {navigation ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-expanded={navigation.expanded}
                aria-label={navigation.expanded ? t('collapse') : t('expand')}
                disabled={!navigation.ready}
                className="touch-hitbox grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:text-foreground"
                onClick={() => navigation.setTemporary(!navigation.expanded)}
                size={null}
                type="button"
                variant="custom"
              >
                <SidebarIcon size={17} aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {navigation.expanded ? t('collapse') : t('expand')}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="border-t border-border pt-2">
        <WorkspaceSwitcher collapsed={collapsed} organizationName={organizationName} />
      </div>
    </div>
  )
}

function Brand({ brand, collapsed }: { brand: SidebarBrand; collapsed: boolean }) {
  return (
    <SidebarLink
      className="flex min-w-0 items-center gap-2.5 rounded-md"
      href="/home"
      aria-label={`${brand.name} Home`}
    >
      {brand.logoUrl ? (
        // An organization's own host, which next/image is not configured for.
        <img alt="" className="size-6 rounded-md object-contain" src={brand.logoUrl} />
      ) : (
        <Image
          alt=""
          className="size-6 rounded-md"
          height={24}
          src={publicImageUrl('/logo-mark.png')}
          width={24}
        />
      )}
      {collapsed ? null : (
        <span className="truncate text-[15px] font-medium text-foreground">{brand.name}</span>
      )}
    </SidebarLink>
  )
}

type SidebarBrand = { logoUrl?: string; name: string }

export interface PlatformSidebarProps {
  /** The organization's white-label name and logo, or Shots'. */
  brand?: SidebarBrand
  campaignsEnabled: boolean
  /** Show Drafts; content drafts are behind PLATFORM_CONTENT_DRAFTS. */
  draftsEnabled?: boolean
  /** The layout the navigation cookie names, for the first paint. */
  initialNavigation?: z.infer<typeof navigationLayoutSchema>
  /** Who is signed in where, from the server, for the notification count. */
  notificationIdentity?: { userId: string; workspaceId: string }
  organizationName?: string
  /** False when the plan lacks content drafts: Home, Publish and New → Post are marked Pro. */
  draftsPlan?: boolean
  /** False without a paid plan, which marks the paid areas before they are opened. */
  paidPlan?: boolean
  /** What the member's permission group subtracts from `role`. */
  deniedPermissions?: readonly string[]
  /** The member's workspace role; New offers what it may create. */
  role?: string
  variant: 'editor' | 'page'
}

const navigationOverrides = new Map<string, boolean>()
function subscribeNavigation(callback: () => void) {
  window.addEventListener('shots:navigation', callback)
  return () => window.removeEventListener('shots:navigation', callback)
}

/** Keep the user's toggle across destinations and editor/page shell remounts. */
function useNavigationExpanded(
  initial: z.infer<typeof navigationLayoutSchema>,
  variant: 'editor' | 'page'
) {
  const { preferences, status } = usePreferences()
  const { data: session } = useHydratedSession()
  const layout =
    variant === 'editor' && !preferences?.version && initial === 'expanded'
      ? 'compact'
      : (preferences?.navigation ?? initial)
  const wide = useMediaQuery(DYNAMIC_NAVIGATION_QUERY)
  const key = session
    ? `shots:nav:${session.user.id}:${session.session.activeOrganizationId}:${preferences?.navigation ?? initial}`
    : null
  const temporary = useSyncExternalStore(
    subscribeNavigation,
    useCallback(() => {
      if (!key) return null
      if (navigationOverrides.has(key)) return navigationOverrides.get(key)!
      try {
        const remembered = sessionStorage.getItem(key)
        return remembered === 'expanded' ? true : remembered === 'compact' ? false : null
      } catch {
        return null
      }
    }, [key]),
    () => null
  )
  return {
    ready: Boolean(key) && status !== 'loading',
    expanded: temporary ?? (layout === 'expanded' || (layout === 'dynamic' && wide)),
    setTemporary: (value: boolean) => {
      if (!key) return
      navigationOverrides.set(key, value)
      try {
        sessionStorage.setItem(key, value ? 'expanded' : 'compact')
      } catch {
        /* The in-memory override still survives client navigation. */
      }
      window.dispatchEvent(new Event('shots:navigation'))
    },
  }
}

/**
 * Desktop: section icons in the fixed rail, with labels in tooltips.
 * Mobile: a full drawer of the same links.
 */
export function PlatformSidebar({
  brand = { name: 'Shots' },
  campaignsEnabled,
  deniedPermissions = [],
  draftsEnabled = false,
  draftsPlan = true,
  initialNavigation = 'expanded',
  notificationIdentity,
  organizationName = 'Workspace',
  paidPlan = true,
  role = 'viewer',
  variant,
}: PlatformSidebarProps) {
  const t = useTranslations('platformNavigation')
  // Keep the same account position in every workspace.
  const [mobileOpen, setMobileOpen] = useState(false)
  const navigation = useNavigationExpanded(initialNavigation, variant)
  const collapsed = !navigation.expanded

  return (
    <>
      <Suspense fallback={null}>
        <RememberVisits />
      </Suspense>
      <ShellSearch
        campaignsEnabled={campaignsEnabled}
        canManage={accessAllows({ deniedPermissions, role }, 'workspace:update')}
        // Posts are searched only where the plan can read them.
        draftsEnabled={draftsEnabled && draftsPlan}
        paidPlan={paidPlan}
        workspaceId={notificationIdentity?.workspaceId}
      />
      <aside
        aria-label="Primary navigation"
        data-platform-sidebar
        className={cn(
          'hidden h-full shrink-0 flex-col px-3 pt-4 pb-3 md:flex',
          collapsed
            ? 'w-[var(--platform-nav-compact)] items-center'
            : 'w-[var(--platform-nav-expanded)]',
          surface.base
        )}
        data-navigation={collapsed ? 'compact' : 'expanded'}
      >
        <div
          className={cn(
            'flex w-full items-center',
            collapsed ? 'flex-col gap-2' : 'h-8 justify-between gap-2 ps-2'
          )}
        >
          <Brand brand={brand} collapsed={collapsed} />
          <div className={cn('flex items-center gap-0.5', collapsed && 'flex-col')}>
            <NotificationCenter initialIdentity={notificationIdentity} />
            <SearchButton />
          </div>
        </div>

        <div className="mt-5 min-h-0 w-full flex-1 overflow-y-auto overscroll-contain px-0.5 py-1">
          <Navigation
            campaignsEnabled={campaignsEnabled}
            collapsed={collapsed}
            draftsEnabled={draftsEnabled}
            draftsPlan={draftsPlan}
            paidPlan={paidPlan}
            deniedPermissions={deniedPermissions}
            role={role}
          />
        </div>

        <SidebarFooter
          collapsed={collapsed}
          navigation={navigation}
          organizationName={organizationName}
          paidPlan={paidPlan}
        />
      </aside>

      <header
        className={cn(
          'platform-mobile-header z-30 flex shrink-0 items-center gap-3 border-b border-border md:hidden',
          surface.base
        )}
      >
        <Brand brand={brand} collapsed={false} />
        <div className="ms-auto flex items-center gap-1">
          <ThemeToggle />
          <NotificationCenter initialIdentity={notificationIdentity} />
          <Sheet onOpenChange={setMobileOpen} open={mobileOpen}>
            <SheetTrigger asChild>
              <Button
                variant="custom"
                size={null}
                aria-label={t('openNavigation')}
                className="grid size-11 place-items-center rounded-lg text-foreground/65 hover:bg-foreground/[0.04] hover:text-foreground"
                type="button"
              >
                <MenuIcon size={20} />
              </Button>
            </SheetTrigger>
            <SheetContent
              data-platform-sidebar
              className="platform-overlay platform-navigation-drawer gap-0 border-border p-3"
              side="left"
            >
              <SheetTitle className="sr-only">{t('navigation')}</SheetTitle>
              <div className="flex h-8 shrink-0 items-center justify-between gap-2 ps-2 pe-12">
                <Brand brand={brand} collapsed={false} />
                <SearchButton />
              </div>
              <div className="mt-5 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 py-1">
                <Navigation
                  campaignsEnabled={campaignsEnabled}
                  collapsed={false}
                  draftsEnabled={draftsEnabled}
                  draftsPlan={draftsPlan}
                  paidPlan={paidPlan}
                  deniedPermissions={deniedPermissions}
                  role={role}
                  onNavigate={() => setMobileOpen(false)}
                />
              </div>
              <SidebarFooter
                collapsed={false}
                organizationName={organizationName}
                paidPlan={paidPlan}
              />
            </SheetContent>
          </Sheet>
        </div>
      </header>
    </>
  )
}
