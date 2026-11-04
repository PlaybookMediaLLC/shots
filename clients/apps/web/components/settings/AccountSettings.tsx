'use client'

import { UserAvatar } from '@/components/auth/UserAvatar'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { z } from 'zod'
import { ProfileForm } from '@/components/auth/ProfileForm'
import { Group, Pill, Row } from '@/components/platform-ui'
import { ConfirmDialog } from '@/components/settings/ConfirmDialog'
import { SaveStatus, useSaveState } from '@/components/settings/controls'
import { usePreferences } from '@/components/settings/PreferencesProvider'
import { TimeZonePicker } from '@/components/settings/TimeZonePicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { accountDeletionStatusSchema } from '@/lib/api/contracts/settings-platform'
import { authClient, useHydratedSession } from '@/lib/auth/client'
import { settingsErrorMessage, settingsRequest } from '@/lib/settings/client'

const PROVIDER_NAMES: Record<string, string> = {
  credential: 'Email and password',
  github: 'GitHub',
  google: 'Google',
  microsoft: 'Microsoft',
  sso: 'Single sign-on',
}

const emailSchema = z.string().trim().toLowerCase().email().max(320)

function Avatar({ image, name }: { image: string | null | undefined; name: string }) {
  return <UserAvatar image={image} name={name} className="size-12 text-sm" />
}

function SignInEmail({ email }: { email: string }) {
  const [next, setNext] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const parsed = emailSchema.safeParse(next)
  const valid = parsed.success && parsed.data !== email.toLowerCase()

  const change = async () => {
    if (!parsed.success) return
    setSending(true)
    const { error } = await authClient.changeEmail({
      callbackURL: '/settings/account',
      newEmail: parsed.data,
    })
    setSending(false)
    if (error) {
      toast.error(error.message ?? 'The email change could not start.')
      return
    }
    setSent(true)
    setNext('')
  }

  return (
    <Row
      description={
        sent
          ? `We sent a confirmation link to ${email}. Open it, then verify the new address from the email we send there. Your sign-in email changes only after both steps.`
          : 'Your sign-in email, where notifications are sent. Changing it needs a confirmation from this address and a verification of the new one.'
      }
      label={`Sign-in and notification email: ${email}`}
      layout="stacked"
    >
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void change()
        }}
      >
        <Input
          aria-label="New email address"
          className="max-w-xs"
          onChange={(event) => setNext(event.target.value)}
          placeholder="new@example.com"
          type="email"
          value={next}
        />
        <Button disabled={!valid || sending} type="submit" variant="outline">
          {sending ? 'Sending…' : 'Change email'}
        </Button>
      </form>
    </Row>
  )
}

function DisplayTimeZone() {
  const { preferences, save, status } = usePreferences()
  const [state, run] = useSaveState()
  const [draft, setDraft] = useState<{ timeZone: string | null } | null>(null)
  const value = draft ? draft.timeZone || null : preferences?.timeZone ?? null
  const dirty = value !== (preferences?.timeZone ?? null)
  return (
    <Row
      description="How times show to you in lists, notifications and the composer. Each publishing brand keeps its own scheduling time zone, and changing this one reschedules nothing."
      label={
        <span className="flex items-center gap-2">
          Display time zone <SaveStatus state={dirty ? 'idle' : state} />
        </span>
      }
      layout="stacked"
    >
      <TimeZonePicker
        allowBrowser
        disabled={status !== 'ready' || state === 'saving'}
        hideLabel
        label="Display time zone"
        onChange={(timeZone) => setDraft({ timeZone })}
        value={value}
      />
      <div className="flex items-center gap-2">
        <Button disabled={!dirty || state === 'saving'} onClick={async () => {
          if (await run(() => save({ timeZone: value ?? '' }))) setDraft(null)
        }}>Save time zone</Button>
        <Button variant="outline" disabled={!dirty || state === 'saving'} onClick={() => setDraft(null)}>Discard</Button>
        {dirty ? <span className="text-xs text-muted-foreground">Unsaved time zone</span> : null}
      </div>
    </Row>
  )
}

function SignInMethods() {
  const accounts = useQuery({
    queryFn: async () => {
      const { data, error } = await authClient.listAccounts()
      if (error) throw new Error(error.message ?? 'Sign-in methods could not be loaded.')
      return data
    },
    queryKey: ['auth', 'accounts'],
  })
  return (
    <Row description="The ways you can sign in to this account." label="Sign-in methods">
      <div className="flex flex-wrap gap-2">
        {accounts.isPending ? (
          <span className="text-sm text-muted-foreground">Loading…</span>
        ) : null}
        {accounts.isError ? (
          <span className="text-sm text-red-700 dark:text-red-300">
            {settingsErrorMessage(accounts.error)}
          </span>
        ) : null}
        {accounts.data?.map((account) => (
          <Pill key={account.id}>{PROVIDER_NAMES[account.providerId] ?? account.providerId}</Pill>
        ))}
      </div>
    </Row>
  )
}

function deviceName(userAgent: string | null | undefined): string {
  if (!userAgent) return 'Unknown device'
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Chrome\//.test(userAgent)
      ? 'Chrome'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Browser'
  const system = /iPhone|iPad/.test(userAgent)
    ? 'iOS'
    : /Android/.test(userAgent)
      ? 'Android'
      : /Mac OS X/.test(userAgent)
        ? 'macOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : ''
  return system ? `${browser} on ${system}` : browser
}

function Sessions() {
  const [requested, setRequested] = useState(false)
  const queryClient = useQueryClient()
  const { data: current } = useHydratedSession()
  const sessions = useQuery({
    queryFn: async () => {
      const { data, error } = await authClient.listSessions()
      if (error)
        throw Object.assign(new Error(error.message ?? 'Sessions could not be loaded.'), {
          code: error.code,
        })
      return data
    },
    queryKey: ['auth', 'sessions'],
    enabled: requested,
    retry: false,
  })

  const revoke = async (token: string) => {
    const { error } = await authClient.revokeSession({ token })
    if (error) {
      toast.error(error.message ?? 'The session could not be signed out.')
      return
    }
    toast.success('That device is signed out.')
    await queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] })
  }

  return (
    <>
      <Row description="Devices signed in to your account." label="Sessions" layout="stacked">
        {!requested ? <Button variant="outline" onClick={() => setRequested(true)}>View signed-in devices</Button> : null}
        {requested && sessions.isPending ? (
          <p className="text-sm text-muted-foreground">Loading sessions…</p>
        ) : null}
        {sessions.isError ? (
          <div className="grid gap-2">
            <p className={'code' in sessions.error && sessions.error.code === 'SESSION_NOT_FRESH' ? 'text-sm text-muted-foreground' : 'text-sm text-red-700 dark:text-red-300'} role="status">
              {'code' in sessions.error && sessions.error.code === 'SESSION_NOT_FRESH'
                ? 'Confirm your sign-in to view and manage your sessions.'
                : settingsErrorMessage(sessions.error)}
            </p>
            <div className="flex gap-2">
              <Button asChild variant="outline">
                <Link href="/sign-in?reauthenticate=1&callbackURL=%2Fworkspace%2Faccount">
                  Verify identity
                </Link>
              </Button>
              {!('code' in sessions.error && sessions.error.code === 'SESSION_NOT_FRESH') ? <Button
                disabled={sessions.isFetching}
                onClick={() => void sessions.refetch()}
                type="button"
                variant="outline"
              >
                Retry
              </Button> : null}
            </div>
          </div>
        ) : null}
        <ul className="grid gap-2">
          {sessions.data?.map((session) => {
            const isCurrent = session.id === current?.session.id
            return (
              <li
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                key={session.id}
              >
                <span>
                  <span className="font-medium text-foreground">
                    {deviceName(session.userAgent)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Signed in {new Date(session.createdAt).toLocaleString()}
                    {isCurrent ? ' · This device' : ''}
                  </span>
                </span>
                {isCurrent ? null : (
                  <Button
                    onClick={() => void revoke(session.token)}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Sign out
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      </Row>
      <Row description="Sign out of this device, or of every device at once." label="Log out">
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={async () => {
              await authClient.signOut()
              window.location.assign('/sign-in')
            }}
            type="button"
            variant="outline"
          >
            Log out
          </Button>
          <ConfirmDialog
            confirmLabel="Log out everywhere"
            description="Every device signed in to your account, including this one, is signed out. You will sign in again here."
            onConfirm={async () => {
              const others = await authClient.revokeOtherSessions()
              if (others.error)
                return others.error.message ?? 'The other sessions could not be signed out.'
              await authClient.signOut()
              window.location.assign('/sign-in?signedOut=everywhere')
              return null
            }}
            title="Log out of every session?"
            triggerLabel="Log out all sessions"
          />
        </div>
      </Row>
    </>
  )
}

function HelpTips() {
  const { preferences, save, status } = usePreferences()
  const [state, run] = useSaveState()
  const count = preferences?.dismissedTips.length ?? 0
  return (
    <Row
      description={
        count === 0
          ? 'Every help tip shows. Your drafts and settings are not affected by this.'
          : `You hid ${count} help tip${count === 1 ? '' : 's'}. Resetting shows them again and changes nothing else.`
      }
      label="Help tips"
    >
      <div className="flex items-center gap-3">
        <SaveStatus state={state} />
        <Button
          disabled={status !== 'ready' || count === 0}
          onClick={() => void run(() => save({ resetTips: true }))}
          type="button"
          variant="outline"
        >
          Reset help tips
        </Button>
      </div>
    </Row>
  )
}

function AccountDeletion({ email }: { email: string }) {
  const queryClient = useQueryClient()
  const status = useQuery({
    queryFn: () => settingsRequest('/api/v1/me/account-deletion', accountDeletionStatusSchema),
    queryKey: ['me', 'account-deletion'],
  })
  const request = status.data?.request
  const blockers = status.data?.blockers ?? []

  const ask = async (confirmation: string) => {
    try {
      const next = await settingsRequest(
        '/api/v1/me/account-deletion',
        accountDeletionStatusSchema,
        {
          body: { confirmation },
          method: 'POST',
        }
      )
      queryClient.setQueryData(['me', 'account-deletion'], next)
      return null
    } catch (error) {
      return settingsErrorMessage(error)
    }
  }
  const cancel = async () => {
    try {
      const next = await settingsRequest(
        '/api/v1/me/account-deletion',
        accountDeletionStatusSchema,
        { method: 'DELETE' }
      )
      queryClient.setQueryData(['me', 'account-deletion'], next)
      toast.success('Your account will not be deleted.')
    } catch (error) {
      toast.error(settingsErrorMessage(error))
    }
  }

  return (
    <Row
      description={
        request
          ? `Your account is scheduled for deletion on ${new Date(request.executeAfter).toLocaleDateString()}. Until then you can cancel. After that, you are signed out everywhere, your sign-in methods and memberships are removed, and your name and email are erased; workspaces keep their content and audit history.`
          : 'Deleting your account signs you out everywhere, removes your sign-in methods and memberships, and erases your name and email after a 14-day grace period. Workspaces you belong to keep their content.'
      }
      label="Delete account"
      layout="stacked"
    >
      {status.isError ? (
        <p className="text-sm text-red-700 dark:text-red-300" role="alert">
          {settingsErrorMessage(status.error)}
        </p>
      ) : null}
      {blockers.length > 0 ? (
        <ul className="grid gap-1 text-sm text-amber-700 dark:text-amber-300">
          {blockers.map((blocker) => (
            <li key={blocker.workspaceId}>{blocker.message}</li>
          ))}
        </ul>
      ) : null}
      <div>
        {request ? (
          <Button onClick={() => void cancel()} type="button" variant="outline">
            Cancel deletion
          </Button>
        ) : (
          <ConfirmDialog
            confirmLabel="Request deletion"
            confirmText={email}
            description={
              <>
                <p>Your account will be deleted in 14 days unless you cancel.</p>
                <p>
                  This needs a sign-in in the last 15 minutes with two-factor authentication on. If
                  it is refused, sign in again and retry.
                </p>
              </>
            }
            destructive
            disabled={status.isPending || blockers.length > 0}
            onConfirm={ask}
            title="Delete your account?"
            triggerLabel="Request account deletion"
          />
        )}
      </div>
    </Row>
  )
}

/**
 * Your account (RFC 024): profile, sign-in email, display time zone, how you
 * sign in, where you are signed in, help tips and account deletion. All of it
 * is yours alone and follows you to every workspace.
 */
export function AccountSettings({ email, name }: { email: string; name: string }) {
  const { data: session } = useHydratedSession()
  return (
    <div className="grid gap-6">
      <div className="flex items-center gap-3">
        <Avatar image={session?.user.image} name={name || email} />
        <div>
          <p className="text-ui-lg font-medium text-foreground">{name || email}</p>
          <p className="text-xs text-muted-foreground">
            Your picture comes from the account you sign in with.
          </p>
        </div>
      </div>
      <ProfileForm email={email} name={name} />
      <Group>
        <SignInEmail email={email} />
        <DisplayTimeZone />
        <SignInMethods />
      </Group>
      <Group>
        <Sessions />
      </Group>
      <Group>
        <HelpTips />
        <AccountDeletion email={email} />
      </Group>
    </div>
  )
}
