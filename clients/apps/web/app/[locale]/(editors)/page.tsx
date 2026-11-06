import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getLocalizedPath, getPageAccess } from '@/lib/auth/page-access'

type RootPageProps = {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/**
 * The editor lives at `/editor`. Every older link and bookmark to `/` keeps
 * working, with its query (a project, an asset, UTM tags). Signed out, the bare
 * address opens sign-in directly; `/editor` sends everyone else on from there.
 */
export default async function RootPage({ params, searchParams }: RootPageProps) {
  const [{ locale }, requestHeaders] = await Promise.all([params, headers()])
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(await searchParams))
    for (const item of [value ?? []].flat()) query.append(key, item)
  const search = query.size ? `?${query}` : ''
  const access = await getPageAccess(requestHeaders)
  redirect(getLocalizedPath(locale, access ? `/editor${search}` : `/sign-in${search}`))
}
