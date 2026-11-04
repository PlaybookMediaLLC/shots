import { redirect } from 'next/navigation'
import { getLocalizedPath } from '@/lib/auth/page-access'

type CalendarPageProps = {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ week?: string }>
}

/** The drafts calendar moved to Write's Plan (RFC 025); old links keep working. */
export default async function DraftsCalendarPage({ params, searchParams }: CalendarPageProps) {
  const { locale } = await params
  const { week } = await searchParams
  redirect(
    getLocalizedPath(locale, week ? `/publish/calendar?week=${encodeURIComponent(week)}` : '/publish/calendar')
  )
}
