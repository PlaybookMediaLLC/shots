import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { requirePaidPageAccess } from '@/lib/auth/page-access'
import { STORE_SCREENSHOTS } from '@/lib/platform/navigation'

export const metadata = { title: `${STORE_SCREENSHOTS.label} · Create` }

/** Store screenshots and its projects (`/create/store/<id>`); the editors layout renders the studio. */
export default async function StoreScreenshotsPage({
  params,
}: {
  params: Promise<{ locale: string; project?: string[] }>
}) {
  const { locale, project = [] } = await params
  if (project.length > 1) notFound()
  const path = project.length ? `${STORE_SCREENSHOTS.href}/${project[0]}` : STORE_SCREENSHOTS.href
  await requirePaidPageAccess(await headers(), locale, path)
  return null
}
