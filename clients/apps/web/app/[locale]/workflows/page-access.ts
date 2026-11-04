import 'server-only'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getLocalizedPath, getPageAccess } from '@/lib/auth/page-access'
import { accessAllows } from '@/lib/auth/permissions'

/**
 * Shared guard for the Workflows pages: signed in with a workspace. Every
 * member can inspect workflows and runs; owners and admins manage them, and
 * the backend enforces both again on every request.
 */
export async function requireWorkflowPageAccess(locale: string) {
  const access = await getPageAccess(await headers())
  if (!access) redirect(getLocalizedPath(locale, '/sign-in'))
  if (!access.hasOrganization || !access.organization) {
    redirect(getLocalizedPath(locale, '/onboarding'))
  }
  return {
    ...access,
    canManage: accessAllows(access, 'workspace:update'),
    organization: access.organization,
  }
}
