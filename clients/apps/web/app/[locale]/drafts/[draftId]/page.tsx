import { redirect } from 'next/navigation'
import { getLocalizedPath } from '@/lib/auth/page-access'

type DraftPageProps = {
  params: Promise<{ draftId: string; locale: string }>
}

/** A draft's old address opens it in Write (RFC 025). */
export default async function DraftPage({ params }: DraftPageProps) {
  const { draftId, locale } = await params
  redirect(getLocalizedPath(locale, `/publish/${encodeURIComponent(draftId)}`))
}
