import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { permanentRedirect, redirect } from 'next/navigation'
import {
  getLocalizedPath,
  getPageAccess,
  unpaidLandingPath,
  upgradePath,
} from '@/lib/auth/page-access'
import { STORE_SCREENSHOTS } from '@/lib/platform/navigation'

export const metadata: Metadata = {
  title: 'Editor',
  robots: { index: false },
}

type EditorPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
  params: Promise<{ locale: string }>
}

export default async function EditorPage({ params, searchParams }: EditorPageProps) {
  const [{ locale }, requestHeaders] = await Promise.all([params, headers()])
  const query = await searchParams
  if (typeof query.new === 'string') redirect(getLocalizedPath(locale, `/publish?${new URLSearchParams({new: query.new})}`))
  // The store studio moved to its own route; old links, with or without a project, land there.
  if (query.editor === 'app-store') {
    const project = typeof query.storeProject === 'string' ? `/${encodeURIComponent(query.storeProject)}` : ''
    permanentRedirect(getLocalizedPath(locale, `${STORE_SCREENSHOTS.href}${project}`))
  }
  const access = await getPageAccess(requestHeaders)
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query))
    for (const item of [value].flat()) if (item !== undefined) search.append(key, item)
  // Signed out, the bare address opens sign-in. Its query goes along, so
  // campaign (UTM) tags on shared links survive the redirect.
  if (!access) redirect(getLocalizedPath(locale, `/sign-in${search.size ? `?${search}` : ''}`))
  if (!access.hasOrganization) redirect(getLocalizedPath(locale, '/onboarding'))
  if (!access.isWorkspaceOperational) redirect(getLocalizedPath(locale, '/settings'))
  if (!access.hasPaidPlan) {
    // Opening a project or the store studio names the editor on the plan page;
    // the bare address is just the way into the app.
    if (!access.hasBasicScheduling || search.size === 0) redirect(unpaidLandingPath(locale, access))
    redirect(upgradePath(locale, `/editor?${search}`))
  }

  // The editors layout renders the screenshot editor.
  return null
}
