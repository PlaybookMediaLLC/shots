import { redirect } from 'next/navigation'
import { getLocalizedPath } from '@/lib/auth/page-access'

type ProfilePageProps = {
  params: Promise<{ locale: string }>
}

export default async function ProfilePage({ params }: ProfilePageProps) {
  const { locale } = await params
  redirect(getLocalizedPath(locale, '/settings/account'))
}
