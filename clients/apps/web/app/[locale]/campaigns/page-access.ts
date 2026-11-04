import 'server-only'

import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'
import { getRequestId, type TenantContext } from '@/lib/auth/access'
import { getLocalizedPath, getPageAccess, upgradePath } from '@/lib/auth/page-access'

/**
 * Shared guard for the campaign pages: signed in, in an operational
 * workspace with a paid plan, and inside the campaign workflow rollout. Outside the rollout
 * the pages do not exist.
 */
export async function requireCampaignPageAccess(locale: string) {
  const requestHeaders = await headers()
  const access = await getPageAccess(requestHeaders)
  if (!access) redirect(getLocalizedPath(locale, '/sign-in'))
  if (!access.hasOrganization || !access.organization) {
    redirect(getLocalizedPath(locale, '/onboarding'))
  }
  if (!access.isWorkspaceOperational) redirect(getLocalizedPath(locale, '/settings'))
  if (!access.hasPaidPlan) redirect(upgradePath(locale, '/campaigns'))
  if (!access.campaignWorkflowEnabled) notFound()
  // Tenant reads run as the signed-in session, scoped to the active workspace.
  const tenant: TenantContext = {
    organizationId: access.organization.id,
    principal: {
      display: access.session.user.email,
      kind: 'session',
      sessionId: access.session.session.id,
      userId: access.session.user.id,
    },
    requestId: getRequestId(requestHeaders),
  }
  return { ...access, organization: access.organization, tenant }
}
