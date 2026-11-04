import { redirect } from 'next/navigation'
import { getLocalizedPath } from '@/lib/auth/page-access'

type DraftsPageProps = {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ socialSet?: string }>
}

/** Drafts moved to Write (RFC 025); old links keep working, set and all. */
export default async function DraftsPage({ params, searchParams }: DraftsPageProps) {
  const { locale } = await params
  const { socialSet } = await searchParams
  redirect(getLocalizedPath(locale, socialSet ? `/publish?set=${encodeURIComponent(socialSet)}` : '/publish'))
}
