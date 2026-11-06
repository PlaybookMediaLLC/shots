import { redirect } from 'next/navigation'
import { getLocalizedPath } from '@/lib/auth/page-access'

type RootPageProps = {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/**
 * The editor lives at `/editor`. Every older link and bookmark to `/` keeps
 * working, with its query (a project, an asset, UTM tags), and whoever may not
 * open the editor is sent on from there.
 */
export default async function RootPage({ params, searchParams }: RootPageProps) {
  const { locale } = await params
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(await searchParams))
    for (const item of [value ?? []].flat()) query.append(key, item)
  redirect(getLocalizedPath(locale, query.size ? `/editor?${query}` : '/editor'))
}
