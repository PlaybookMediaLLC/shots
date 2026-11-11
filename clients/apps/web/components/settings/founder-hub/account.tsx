'use client'

import { AccountSettings } from '@/components/settings/AccountSettings'
import { useHydratedSession } from '@/lib/auth/client'
import { SettingsPageTitle } from './page-title'

/** Reuse Shots' authenticated account controls inside Founder Hub settings. */
export function SettingsAccount() {
  const session = useHydratedSession()
  if (session.isPending) return <p role="status">Loading account…</p>
  if (!session.data) return <p role="alert">Sign in to manage your account.</p>

  return (
    <div className="grid gap-8">
      <SettingsPageTitle title="Account" />
      <AccountSettings email={session.data.user.email} name={session.data.user.name} />
    </div>
  )
}
