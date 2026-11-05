import { cookies, headers } from 'next/headers'
import type { ReactNode } from 'react'
import { OnboardingProgressCard } from '@/components/onboarding/OnboardingProgressCard'
import { PreferencesProvider } from '@/components/settings/PreferencesProvider'
import { PendingDraftInput } from '@/components/write/pending-draft'
import { getPageAccess } from '@/lib/auth/page-access'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'
import { NAVIGATION_COOKIE, parseNavigation } from '@/lib/settings/appearance'
import type { PlatformAccess } from '@/lib/platform/navigation'
import { brandIdentity, brandThemeCss } from '@/lib/whitelabeling'
import { cn } from '@/lib/utils'
import { PlatformSidebar } from './PlatformSidebar'
import { ProductTourProvider } from './ProductTour'
import { WorkspaceTabGuard } from './WorkspaceTabGuard'
import { surface } from './shell-config'
import './platform-shell.css'
import '../platform-hub/platform-home.css'

export interface PlatformShellProps {
  /** Show Campaigns; the campaign workflow is behind a rollout flag. */
  campaignsEnabled?: boolean
  children: ReactNode
  organizationName?: string
  /**
   * `page` puts the page on a rounded panel inset from the sidebar.
   * `editor` sits flush beside the editor, which fills the viewport and
   * brings its own account menu and mobile chrome.
   */
  variant?: 'editor' | 'page'
}

/**
 * Signed-in app chrome: the navigation beside the page, laid out as the
 * person chose (RFC 024), with their preferences loaded for every page.
 *
 * Fork-owned on purpose. Pages wrap themselves in it, so upstream editor
 * files and the upstream shadcn sidebar (whose cookie and ⌘B shortcut the
 * editor already uses) stay untouched.
 */
export async function PlatformShell({
  campaignsEnabled = false,
  children,
  organizationName,
  variant = 'page',
}: PlatformShellProps) {
  const [cookieStore, access] = await Promise.all([cookies(), headers().then(getPageAccess)])
  const navigation = parseNavigation(cookieStore.get(NAVIGATION_COOKIE)?.value)
  // One reading of the plan and flags for the sidebar and the product tours.
  const platformAccess: PlatformAccess = {
    campaignsEnabled,
    draftsEnabled: contentDraftsEnabled(),
    draftsPlan: access?.hasBasicScheduling ?? true,
    paidPlan: access?.hasPaidPlan ?? true,
  }
  const brandCss = brandThemeCss(access?.whitelabel)
  return (
    <PreferencesProvider>
      {/* Rendered with the shell, so branding stays out of public pages. */}
      {brandCss ? <style>{brandCss}</style> : null}
      {access?.whitelabel?.faviconUrl ? (
        <link href={access.whitelabel.faviconUrl} rel="icon" />
      ) : null}
      <ProductTourProvider access={platformAccess} autoStart={variant === 'page'}>
        <div
          data-platform-shell
          data-platform-variant={variant}
          className={cn(
            'platform-shell flex h-dvh min-h-0 flex-col overflow-hidden text-foreground md:flex-row',
            surface.base
          )}
        >
          <a
            className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-background focus:p-3"
            href="#platform-content"
          >
            Skip to content
          </a>
          <PlatformSidebar
            brand={brandIdentity(access?.whitelabel)}
            campaignsEnabled={platformAccess.campaignsEnabled}
            deniedPermissions={access?.deniedPermissions}
            draftsEnabled={platformAccess.draftsEnabled}
            draftsPlan={platformAccess.draftsPlan}
            initialNavigation={navigation}
            notificationIdentity={
              access?.organization
                ? { userId: access.session.user.id, workspaceId: access.organization.id }
                : undefined
            }
            organizationName={organizationName}
            paidPlan={platformAccess.paidPlan}
            role={access?.role ?? 'viewer'}
            variant={variant}
          />
          {access?.organization ? (
            <WorkspaceTabGuard
              workspaceId={access.organization.id}
              workspaceName={access.organization.name}
            />
          ) : null}
          {variant === 'page' ? (
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden md:py-3 md:pe-3">
              <div
                data-platform-scroll
                id="platform-content"
                tabIndex={0}
                aria-label="Page content"
                role="region"
                className={cn(
                  // `relative` keeps hidden form inputs in here, or they make the window scroll too.
                  'relative h-full min-h-0 overflow-y-auto overscroll-contain md:rounded-2xl md:border',
                  surface.panel,
                  surface.border
                )}
              >
                {children}
              </div>
            </div>
          ) : (
            <div
              id="platform-content"
              tabIndex={-1}
              className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
            >
              {children}
            </div>
          )}
          <OnboardingProgressCard />
          {/* New → Post types here from any page while the draft is made. */}
          <PendingDraftInput />
        </div>
      </ProductTourProvider>
    </PreferencesProvider>
  )
}
