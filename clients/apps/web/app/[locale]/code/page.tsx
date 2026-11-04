import { redirect } from 'next/navigation'
import { getLocalizedPath } from '@/lib/auth/page-access'

/**
 * The code image tool moved into the app as Code Studio (RFC 053). Old links
 * keep working: the browser carries a `#…` snippet through the redirect, and
 * Code Studio opens it.
 */
export default async function CodeImagePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  redirect(getLocalizedPath(locale, '/create/code'))
}
