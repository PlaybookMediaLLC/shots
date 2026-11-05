import 'server-only'

import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { requirePaidPageAccess, sessionTenant } from '@/lib/auth/page-access'
import { contentDraftsEnabled } from '@/lib/content-drafts/flag'

/**
 * Shared guard for the drafts pages: a workspace member with basic scheduling, inside the
 * content drafts rollout (RFC 013). Outside the rollout the pages do not exist.
 */
export async function requireDraftsPageAccess(locale: string, returnTo: string) {
  const requestHeaders = await headers()
  const access = await requirePaidPageAccess(requestHeaders, locale, returnTo, 'content:drafts')
  if (!contentDraftsEnabled() || !access.organization) notFound()
  return {
    ...access,
    organization: access.organization,
    tenant: sessionTenant(access, access.organization.id, requestHeaders),
  }
}
