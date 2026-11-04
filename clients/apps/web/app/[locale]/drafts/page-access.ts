import 'server-only'

import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getRequestId, type OrganizationAccess } from '@/lib/auth/access'
import { requirePaidPageAccess } from '@/lib/auth/page-access'
import { normalizeOrganizationRole } from '@/lib/auth/permissions'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'

/**
 * Shared guard for the drafts pages: a workspace member with basic scheduling, inside the
 * content drafts rollout (RFC 013). Outside the rollout the pages do not exist.
 */
export async function requireDraftsPageAccess(locale: string, returnTo: string) {
  const requestHeaders = await headers()
  const access = await requirePaidPageAccess(requestHeaders, locale, returnTo, 'content:drafts')
  if (!contentDraftsEnabled() || !access.organization) notFound()
  // Reads run as the signed-in session, scoped to the active workspace.
  const tenant: OrganizationAccess = {
    deniedPermissions: access.deniedPermissions,
    organizationId: access.organization.id,
    principal: {
      display: access.session.user.email,
      kind: 'session',
      sessionId: access.session.session.id,
      userId: access.session.user.id,
    },
    requestId: getRequestId(requestHeaders),
    role: normalizeOrganizationRole(access.role),
  }
  return { ...access, organization: access.organization, tenant }
}
