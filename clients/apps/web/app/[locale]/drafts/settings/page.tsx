import { redirect } from 'next/navigation'
import { getLocalizedPath } from '@/lib/auth/page-access'

type SettingsPageProps = { params: Promise<{ locale: string }> }

/** Posting times live on each publishing brand; old links open the brands. */
export default async function DraftsSettingsPage({ params }: SettingsPageProps) {
  const { locale } = await params
  redirect(getLocalizedPath(locale, '/settings/publishing-brands'))
}
