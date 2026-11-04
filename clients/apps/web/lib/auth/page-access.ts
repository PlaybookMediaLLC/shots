import 'server-only'
import { platformHref, safeReturnPath } from '@/lib/platform/navigation'

import { redirect } from 'next/navigation'
import { cache } from 'react'
import type { ListedWorkspace, Workspace } from 'screenshot-studio-backend-sdk'
import { backendSDK } from '@/lib/backend/sdk'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'
import { getRequestId } from './access'
import { auth } from './server'

type SignedInSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>

function backendPageOrganization(active: ListedWorkspace | null, workspace: Workspace | null) {
  if (!active) return null
  return {
    id: active.id,
    logo: workspace?.logo ?? null,
    name: workspace?.name ?? active.name,
    slug: workspace?.slug ?? active.slug,
    workspaceDeletion: backendPageDeletion(active),
    workspaceSettings: workspace?.workspaceSettings ?? null,
  }
}

function backendPageDeletion(active: ListedWorkspace) {
  if (!active.workspaceDeletion) return null
  return {
    ...active.workspaceDeletion,
    scheduledFor: new Date(active.workspaceDeletion.scheduledFor),
  }
}

async function getBackendPageAccess(requestHeaders: Headers, session: SignedInSession) {
  const { active, count, deniedPermissions, workspace, features, whitelabel } = await backendSDK({
    organizationId: '',
    principal: {
      display: session.user.email,
      kind: 'session',
      sessionId: session.session.id,
      userId: session.user.id,
    },
    requestId: getRequestId(requestHeaders),
  }).getPageAccess()
  return {
    // PLATFORM_CAMPAIGN_WORKFLOW=enabled turns the rollout on for a whole
    // environment (local development, staging, e2e).
    campaignWorkflowEnabled:
      Boolean(workspace) &&
      (process.env.PLATFORM_CAMPAIGN_WORKFLOW === 'enabled' ||
        features['campaign:workflow'] === true),
    creativeSetsEnabled: Boolean(workspace) && features['creative-sets:create'] === true,
    // An older backend mid-deploy sends none, and has no groups to apply.
    deniedPermissions: deniedPermissions ?? [],
    hasOrganization: count > 0,
    // The onboarding agent (docs/rfcs/032). The backend decides it, including
    // the PLATFORM_ONBOARDING_AGENT rollback; without it onboarding is manual.
    onboardingAgentEnabled: Boolean(workspace) && features['onboarding:agent'] === true,
    hasBasicScheduling: features['content:drafts'] === true,
    hasPaidPlan: features['workspace:paid'] === true,
    isWorkspaceOperational: Boolean(workspace),
    organization: backendPageOrganization(active, workspace),
    role: active?.role ?? 'viewer',
    session,
    // Set only while the plan grants it, so a lapsed plan shows Shots again.
    whitelabel,
  }
}

async function loadPageAccess(requestHeaders: Headers) {
  const session = await auth.api.getSession({
    headers: requestHeaders,
    query: { disableCookieCache: true },
  })
  if (!session) return null

  return getBackendPageAccess(requestHeaders, session)
}

/**
 * The signed-in person's access, or null without a session. Read once per
 * request, so a page and its shell share one backend round trip.
 */
export const getPageAccess = cache(loadPageAccess)

export function getLocalizedPath(locale: string, path: string): string {
  return locale === 'en' ? path : `/${locale}${path}`
}

/**
 * The in-app plan page for a signed-in workspace that asked for a paid
 * capability. `from` is the in-app path it asked for, kept so the page can
 * name it and return there; the public pricing page would drop both.
 */
export function upgradePath(locale: string, from?: string): string {
  return getLocalizedPath(locale, from ? `/upgrade?from=${encodeURIComponent(from)}` : '/upgrade')
}

/**
 * Where the editor's bare address sends a workspace without a paid plan: Home
 * when its plan includes basic scheduling, otherwise plan choice. Sending a
 * free workspace to pricing makes sign-in look like a page reload.
 */
export function unpaidLandingPath(locale: string, access: { hasBasicScheduling: boolean }): string {
  return access.hasBasicScheduling && contentDraftsEnabled()
    ? getLocalizedPath(locale, '/home')
    : upgradePath(locale)
}

/**
 * Sign-in and sign-up send someone who is already signed in on to the app,
 * or to the in-app page they were headed for. Only same-origin paths are
 * followed, matching the form's own callbackURL check.
 */
export async function redirectIfSignedIn(
  requestHeaders: Headers,
  locale: string,
  callbackURL: string | string[] | undefined
): Promise<void> {
  const session = await auth.api.getSession({ headers: requestHeaders })
  if (!session) return
  const target = safeReturnPath(typeof callbackURL === 'string' ? callbackURL : null)
  redirect(platformHref(locale === 'en' ? '/' : `/${locale}`, target))
}

/**
 * The access for a product page, which needs a signed-in teammate in a
 * workspace with an active paid plan. Anyone else is sent to the step they
 * are missing: sign-in, onboarding, workspace recovery, or the in-app plan page.
 */
export async function requirePaidPageAccess(
  requestHeaders: Headers,
  locale: string,
  returnTo: string,
  feature: 'workspace:paid' | 'content:drafts' = 'workspace:paid'
) {
  const access = await getPageAccess(requestHeaders)
  if (!access) {
    redirect(getLocalizedPath(locale, `/sign-in?callbackURL=${encodeURIComponent(returnTo)}`))
  }
  if (!access.hasOrganization) redirect(getLocalizedPath(locale, '/onboarding'))
  if (!access.isWorkspaceOperational) redirect(getLocalizedPath(locale, '/settings'))
  if (!(feature === 'content:drafts' ? access.hasBasicScheduling : access.hasPaidPlan))
    redirect(upgradePath(locale, returnTo))
  return access
}
