import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { connection } from 'next/server'
import { ChannelIcon } from '@/components/drafts/channel-meta'
import { orNull, serviceBackend } from '@/lib/backend/sdk'
import { channelForPlatform } from '@/lib/content-drafts/serialize'

export const metadata: Metadata = { robots: { follow: false, index: false }, title: 'Profile' }

/** A profile address is 24 lowercase hexadecimal characters. */
const SLUG = /^[0-9a-f]{24}$/

/**
 * A social set's public profile (RFC 024). Rendered on every request and never
 * cached, so turning the profile off takes it down on the next visit; the
 * backend returns nothing for a set whose profile is off. It shows the set's
 * name, colour and its accounts' public identity, and nothing else.
 */
export default async function PublicProfilePage({ params }: { params: Promise<{ slug: string }> }) {
  await connection()
  const { slug } = await params
  if (!SLUG.test(slug)) notFound()
  const profile = await orNull(serviceBackend().getPublicProfile(slug))
  if (!profile) notFound()
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col gap-6 bg-background px-6 py-16 text-foreground">
      <div className="flex items-center gap-4">
        <span aria-hidden className="size-14 rounded-full" style={{ backgroundColor: profile.color }} />
        <h1 className="text-2xl font-medium">{profile.name}</h1>
      </div>
      {profile.accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No accounts to show.</p>
      ) : (
        <ul className="grid gap-3">
          {profile.accounts.map((account, index) => {
            const channel = channelForPlatform(account.platform)
            return (
              <li className="flex items-center gap-3 rounded-xl border border-border px-4 py-3" key={`${account.platform}-${index}`}>
                {channel ? <ChannelIcon channel={channel} className="size-5" /> : null}
                <span className="text-ui-lg font-medium">{account.displayName ?? account.platform}</span>
                {account.handle ? <span className="text-sm text-muted-foreground">@{account.handle}</span> : null}
              </li>
            )
          })}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">Published with Shots.</p>
    </main>
  )
}
