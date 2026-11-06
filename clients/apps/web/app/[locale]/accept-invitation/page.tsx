import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { AcceptInvitation } from '@/components/auth/AcceptInvitation'
import { getLocalizedPath, getPageAccess } from '@/lib/auth/page-access'

export const metadata = { title: 'Workspace invitation' }

type AcceptInvitationPageProps = {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ invitationId?: string }>
}

export default async function AcceptInvitationPage({
  params,
  searchParams,
}: AcceptInvitationPageProps) {
  const [{ locale }, { invitationId }, requestHeaders] = await Promise.all([
    params,
    searchParams,
    headers(),
  ])
  if (!invitationId) redirect(getLocalizedPath(locale, '/sign-in'))
  const access = await getPageAccess(requestHeaders)
  if (!access) {
    const callbackURL = `${getLocalizedPath(locale, '/accept-invitation')}?invitationId=${encodeURIComponent(invitationId)}`
    redirect(
      `${getLocalizedPath(locale, '/sign-in')}?callbackURL=${encodeURIComponent(callbackURL)}`
    )
  }
  return (
    <main className="mx-auto grid min-h-screen w-full max-w-xl place-items-center px-5">
      <AcceptInvitation key={invitationId} invitationId={invitationId} />
    </main>
  )
}
