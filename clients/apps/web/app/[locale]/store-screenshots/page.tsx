import { permanentRedirect } from 'next/navigation'
import { getLocalizedPath } from '@/lib/auth/page-access'
import { STORE_SCREENSHOTS } from '@/lib/platform/navigation'

/** The studio moved to Create › Store screenshots; old links, with or without a project, land there. */
export default async function StoreScreenshotsRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ project?: string | string[] }>
}): Promise<never> {
  const [{ locale }, { project }] = await Promise.all([params, searchParams])
  const id = typeof project === 'string' && project ? `/${encodeURIComponent(project)}` : ''
  permanentRedirect(getLocalizedPath(locale, `${STORE_SCREENSHOTS.href}${id}`))
}
