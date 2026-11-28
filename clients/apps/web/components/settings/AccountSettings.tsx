'use client'

import { UserAvatar } from '@/components/auth/UserAvatar'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { z } from 'zod'
import { ProfileForm } from '@/components/auth/ProfileForm'
import { LocalTime } from '@/components/drafts/local-time'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { ConfirmDialog } from '@/components/settings/ConfirmDialog'
import { SaveStatus, useSaveState } from '@/components/settings/controls'
import { usePreferences } from '@/components/settings/PreferencesProvider'
import { SessionControls } from '@/components/settings/SessionControls'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
    if (!valid || sending || !parsed.success) return
    setSending(true)
    try {
      const { error } = await authClient.changeEmail({
        callbackURL: '/settings/account',
        newEmail: parsed.data,
      })
      if (error) {
        toast.error(error.message ?? 'The email change could not start.')
        return
      }
      setSent(true)
      setNext('')
    } catch (error) {
      toast.error(settingsErrorMessage(error))
    } finally {
      setSending(false)
    }
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
    <>
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
      {accounts.data?.some((account) => account.providerId === 'credential') ? (
        <PasswordSettings />
      ) : null}
    </>
  )
}

function PasswordSettings() {
  const change = useMutation({
    mutationFn: async (form: HTMLFormElement) => {
      const data = new FormData(form)
      const password = z
        .object({
          currentPassword: z.string().min(1, 'Enter your current password.'),
          newPassword: z.string().min(12, 'Use at least 12 characters.').max(128),
          confirmation: z.string(),
        })
        .refine(
          (value) => value.newPassword === value.confirmation,
          'The new passwords must match.'
        )
        .safeParse(Object.fromEntries(data))
      if (!password.success) throw new Error(password.error.issues[0].message)
      const result = await authClient.changePassword({
        currentPassword: password.data.currentPassword,
        newPassword: password.data.newPassword,
        revokeOtherSessions: true,
      })
      if (result.error) throw new Error(result.error.message ?? 'Could not change your password.')
      form.reset()
    },
  })
  return (
    <Row
      label="Password"
      description="Changing your password signs out your other devices, including Founder Hub."
      layout="stacked"
    >
      <form
        className="grid max-w-sm gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          change.mutate(event.currentTarget)
        }}
      >
        <Label>
          Current password
          <Input name="currentPassword" type="password" autoComplete="current-password" required />
        </Label>
        <Label>
          New password
          <Input
            name="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
        </Label>
        <Label>
          Confirm new password
          <Input
            name="confirmation"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
        </Label>
        <Button type="submit" variant="outline" disabled={change.isPending}>
          Change password
        </Button>
        {change.error ? <p role="alert">{change.error.message}</p> : null}
        {change.isSuccess ? (
          <p role="status">Password changed. Your other devices are signed out.</p>
        ) : null}
      </form>
    </Row>
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
  const [reauthAction, setReauthAction] = useState<'reauth' | 'two-factor' | null>(null)
  const [cancelBusy, setCancelBusy] = useState(false)
  const status = useQuery({
    queryFn: () => settingsRequest('/api/v1/me/account-deletion', accountDeletionStatusSchema),
    queryKey: ['me', 'account-deletion'],
  })
  const request = status.data?.request
  const blockers = status.data?.blockers ?? []

  const ask = async (confirmation: string) => {
    setReauthAction(null)
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
      const message = settingsErrorMessage(error)
      if (/two-factor|2fa/i.test(message)) {
        setReauthAction('two-factor')
      } else if (/fresh|reauthenticate|sign in again/i.test(message)) {
        setReauthAction('reauth')
      }
      return message
    }
  }
  const cancel = async () => {
    if (cancelBusy) return
    setCancelBusy(true)
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
    } finally {
      setCancelBusy(false)
    }
  }

  return (
    <Row
      description={
        request?.status === 'PROCESSING' ? (
          'Account deletion has started. Your encrypted Founder Hub data and attachments are being removed. This can no longer be cancelled.'
        ) : request ? (
          <>
            Your account is scheduled for deletion on{' '}
            <LocalTime options={{ dateStyle: 'medium' }} value={request.executeAfter} />. Until then
            you can cancel. After that, you are signed out everywhere, your sign-in methods and
            memberships are removed, and your name and email are erased; workspaces keep their
            content and audit history.
          </>
        ) : (
          'Deleting your account signs you out everywhere, removes your sign-in methods and memberships, and erases your name and email after a 14-day grace period. Workspaces you belong to keep their content.'
        )
      }
      label="Delete account"
      layout="stacked"
    >
      {status.isError ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-red-700 dark:text-red-300" role="alert">
            {settingsErrorMessage(status.error)}
          </p>
          <Button
            disabled={status.isFetching}
            onClick={() => void status.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      ) : null}
      {blockers.length > 0 ? (
        <ul className="grid gap-1 text-sm text-amber-700 dark:text-amber-300">
          {blockers.map((blocker) => (
            <li key={blocker.workspaceId}>{blocker.message}</li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {(() => {
          const recoveryButton =
            reauthAction === 'reauth' ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/sign-in?reauthenticate=1&callbackURL=%2Fsettings%2Faccount">
                  Verify identity
                </Link>
              </Button>
            ) : reauthAction === 'two-factor' ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/settings/security">Enable two-factor authentication</Link>
              </Button>
            ) : null
          return (
            <>
              {request ? (
                <Button
                  disabled={request.status !== 'REQUESTED' || cancelBusy}
                  onClick={() => void cancel()}
                  type="button"
                  variant="outline"
                >
                  {cancelBusy ? 'Cancelling…' : 'Cancel deletion'}
                </Button>
              ) : (
                <ConfirmDialog
                  confirmLabel="Request deletion"
                  confirmText={email}
                  description={
                    <>
                      <p>Your account will be deleted in 14 days unless you cancel.</p>
                      <p>
                        This needs a sign-in in the last 15 minutes with two-factor authentication on.
                        If it is refused, verify your identity and retry.
                      </p>
                    </>
                  }
                  destructive
                  disabled={status.isPending || status.isError || blockers.length > 0}
                  onConfirm={ask}
                  title="Delete your account?"
                  triggerLabel="Delete account"
                >
                  {recoveryButton ? <div>{recoveryButton}</div> : null}
                </ConfirmDialog>
              )}
              {recoveryButton}
            </>
          )
        })()}
      </div>
    </Row>
  )
}

/**
 * Your account (RFC 024): profile, sign-in email, how you sign in, where you
 * are signed in, help tips, legal links, and account deletion. All of it is
 * yours alone and follows you to every workspace.
 */
export function AccountSettings({ email, name }: { email: string; name: string }) {
  const { data: session } = useHydratedSession()
  return (
    <div className="grid gap-8">
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
        <SignInMethods />
      </Group>
      <Group>
        <SessionControls reauthenticateCallback="/settings/account" />
      </Group>
      <Group>
        <HelpTips />
      </Group>
      <Section
        description="Legal policies and permanent account deletion controls."
        title="Privacy & account"
      >
        <Group>
          <Row
            description="How Shots collects, processes, and protects your data."
            label="Privacy policy"
          >
            <Button asChild size="sm" variant="outline">
              <Link href="/privacy-policy">View privacy policy</Link>
            </Button>
          </Row>
          <Row
            description="The terms governing your use of Shots and your workspaces."
            label="Terms of service"
          >
            <Button asChild size="sm" variant="outline">
              <Link href="/terms">View terms of service</Link>
            </Button>
          </Row>
          <AccountDeletion email={email} />
        </Group>
      </Section>
    </div>
  )
}
