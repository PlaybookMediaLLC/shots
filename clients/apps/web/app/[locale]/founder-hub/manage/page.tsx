import { headers } from 'next/headers'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { z } from 'zod'
import { AuthShell } from '@/components/auth/AuthShell'
import { Button } from '@/components/ui/button'
import { findSettingsSection, settingsHref } from '@/components/workspace/settings-sections'
import { getLocalizedPath } from '@/lib/auth/page-access'
import { auth } from '@/lib/auth/server'

const querySchema = z.object({
  user: z.string().min(1).max(160),
  section: z.enum(['account', 'members', 'billing', 'security']),
})

export default async function FounderHubManagePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const [{ locale }, query, requestHeaders] = await Promise.all([params, searchParams, headers()])
  const parsed = querySchema.safeParse(query)
  if (!parsed.success) notFound()
  const returnTo = getLocalizedPath(
    locale,
    `/founder-hub/manage?${new URLSearchParams(parsed.data)}`
  )
  const signIn = getLocalizedPath(
    locale,
    `/sign-in?${new URLSearchParams({ callbackURL: returnTo, reauthenticate: '1' })}`
  )
  const session = await auth.api.getSession({
    headers: requestHeaders,
    query: { disableCookieCache: true },
  })
  if (!session) redirect(signIn)
  if (session.user.id !== parsed.data.user) {
    return (
      <AuthShell
        title="Use your Founder Hub account"
        description={`This browser is signed in as ${session.user.email}. Sign in with the same Shots account you use in Founder Hub to continue.`}
      >
        <Button asChild>
          <Link href={signIn}>Switch account</Link>
        </Button>
      </AuthShell>
    )
  }
  const section = findSettingsSection(parsed.data.section)
  if (!section) notFound()
  redirect(getLocalizedPath(locale, settingsHref(section)))
}
