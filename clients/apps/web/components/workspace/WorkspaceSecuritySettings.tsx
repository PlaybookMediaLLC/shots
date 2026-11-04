'use client'

import { type FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'
import { z } from 'zod'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Group, Pill, Row } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { authClient } from '@/lib/auth/client'
import { getAuthErrorMessage } from '@/components/auth/error-message'
import { Label } from '@/components/ui/label'

const codeSchema = z.string().regex(/^\d{6}$/, 'Enter the six-digit code from your authenticator.')

type SetupState = { backupCodes: string[]; totpURI: string }
type WorkspaceSecuritySettingsProps = { twoFactorEnabled: boolean }

export function WorkspaceSecuritySettings({ twoFactorEnabled }: WorkspaceSecuritySettingsProps) {
  const router = useRouter()
  const accounts = useQuery({
    queryKey: ['auth', 'accounts'],
    queryFn: async () => {
      const result = await authClient.listAccounts()
      if (result.error) throw new Error(result.error.message ?? 'Could not load sign-in methods.')
      return result.data
    },
  })
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [setup, setSetup] = useState<SetupState | null>(null)

  async function enableTwoFactor(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError(null)
    setIsSubmitting(true)
    try {
      const password = String(new FormData(event.currentTarget).get('password') ?? '')
      const result = await authClient.twoFactor.enable({ password })
      if (result.error || !result.data)
        throw new Error(result.error?.message ?? 'Could not start two-factor setup.')
      setSetup(result.data)
    } catch (requestError) {
      setError(getAuthErrorMessage(requestError, 'Could not start two-factor setup.'))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function verifyTwoFactor(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError(null)
    const code = codeSchema.safeParse(new FormData(event.currentTarget).get('code'))
    if (!code.success) {
      setError(code.error.issues[0]?.message ?? 'Enter a valid code.')
      return
    }
    setIsSubmitting(true)
    try {
      const result = await authClient.twoFactor.verifyTotp({ code: code.data })
      if (result.error) throw new Error(result.error.message ?? 'The code could not be verified.')
      router.refresh()
    } catch (requestError) {
      setError(getAuthErrorMessage(requestError, 'The code could not be verified.'))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function disableTwoFactor(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError(null)
    setIsSubmitting(true)
    try {
      const password = String(new FormData(event.currentTarget).get('password') ?? '')
      const result = await authClient.twoFactor.disable({ password })
      if (result.error)
        throw new Error(result.error.message ?? 'Could not disable two-factor authentication.')
      router.refresh()
    } catch (requestError) {
      setError(getAuthErrorMessage(requestError, 'Could not disable two-factor authentication.'))
    } finally {
      setIsSubmitting(false)
    }
  }

  if (accounts.isPending) return <p role="status">Checking sign-in methods…</p>
  if (accounts.isError)
    return (
      <div className="grid gap-2">
        <p role="alert">Could not check your sign-in methods.</p>
        <Button onClick={() => void accounts.refetch()} type="button" variant="outline">
          Retry
        </Button>
      </div>
    )
  if (!accounts.data?.some((account) => account.providerId === 'credential')) {
    return (
      <Group>
        <Row
          label="Two-factor authentication"
          layout="stacked"
          description="Your sign-in provider does not give Shots a password. Authenticator settings currently require a Shots password."
        >
          <p className="text-sm text-muted-foreground">
            Contact your administrator to arrange password sign-in before changing authenticator
            settings. You can also protect your provider account with its own two-step verification.
          </p>
          <Link className="text-sm underline" href="/settings/account">
            View your sign-in methods
          </Link>
        </Row>
      </Group>
    )
  }

  if (twoFactorEnabled)
    return (
      <EnabledSecurityForm error={error} isSubmitting={isSubmitting} onSubmit={disableTwoFactor} />
    )
  if (setup)
    return (
      <VerifySecurityForm
        error={error}
        isSubmitting={isSubmitting}
        onSubmit={verifyTwoFactor}
        setup={setup}
      />
    )
  return <EnableSecurityForm error={error} isSubmitting={isSubmitting} onSubmit={enableTwoFactor} />
}

function EnableSecurityForm({
  error,
  isSubmitting,
  onSubmit,
}: {
  error: string | null
  isSubmitting: boolean
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>
}) {
  return (
    <form className="flex flex-col gap-6" onSubmit={onSubmit}>
      <Group>
        <Row
          description="Add a time-based authenticator to protect sensitive workspace actions."
          label="Two-factor authentication"
          layout="inline"
        >
          <Pill>Off</Pill>
        </Row>
        <PasswordField />
      </Group>
      <FormError error={error} />
      <div className="flex justify-end">
        <Button className="rounded-lg" disabled={isSubmitting} type="submit">
          {isSubmitting ? 'Starting…' : 'Set up authenticator'}
        </Button>
      </div>
    </form>
  )
}

function VerifySecurityForm({
  error,
  isSubmitting,
  onSubmit,
  setup,
}: {
  error: string | null
  isSubmitting: boolean
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>
  setup: SetupState
}) {
  return (
    <form className="flex flex-col gap-6" onSubmit={onSubmit}>
      <Group>
        <Row
          description="Add this URI to your authenticator, store the backup codes, then enter the generated code."
          label="Authenticator URI"
          layout="stacked"
        >
          <code className="w-full overflow-x-auto rounded-lg bg-black/30 p-3 font-mono text-xs text-foreground/80 ring-1 ring-foreground/[0.08]">
            {setup.totpURI}
          </code>
        </Row>
        <Row
          description="Each code signs you in once if you lose your authenticator."
          label="Backup codes"
          layout="stacked"
        >
          <div className="grid w-full grid-cols-2 gap-2 rounded-lg bg-black/30 p-3 font-mono text-xs text-foreground/80 ring-1 ring-foreground/[0.08]">
            {setup.backupCodes.map((backupCode) => (
              <code key={backupCode}>{backupCode}</code>
            ))}
          </div>
        </Row>
        <Row
          description="The six-digit code your authenticator shows."
          label={<Label htmlFor="two-factor-code">Verification code</Label>}
        >
          <Input
            autoComplete="one-time-code"
            className="h-10 rounded-lg md:w-72"
            id="two-factor-code"
            inputMode="numeric"
            name="code"
            required
          />
        </Row>
      </Group>
      <FormError error={error} />
      <div className="flex justify-end">
        <Button className="rounded-lg" disabled={isSubmitting} type="submit">
          {isSubmitting ? 'Verifying…' : 'Verify and enable'}
        </Button>
      </div>
    </form>
  )
}

function EnabledSecurityForm({
  error,
  isSubmitting,
  onSubmit,
}: {
  error: string | null
  isSubmitting: boolean
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>
}) {
  return (
    <form className="flex flex-col gap-6" onSubmit={onSubmit}>
      <Group>
        <Row
          description="Two-factor authentication is enabled for this account."
          label="Two-factor authentication"
          layout="inline"
        >
          <Pill tone="green">Enabled</Pill>
        </Row>
        <PasswordField />
        <Row
          description="Removes the authenticator from your account."
          label="Turn off two-factor"
          layout="inline"
        >
          <Button
            className="rounded-lg"
            disabled={isSubmitting}
            type="submit"
            variant="destructive"
          >
            {isSubmitting ? 'Disabling…' : 'Disable two-factor authentication'}
          </Button>
        </Row>
      </Group>
      <FormError error={error} />
    </form>
  )
}

function PasswordField() {
  return (
    <Row
      description="Confirm it is you before changing two-factor settings."
      label={<Label htmlFor="two-factor-password">Current password</Label>}
    >
      <Input
        autoComplete="current-password"
        className="h-10 rounded-lg md:w-72"
        id="two-factor-password"
        name="password"
        required
        type="password"
      />
    </Row>
  )
}

function FormError({ error }: { error: string | null }) {
  return error ? (
    <Alert variant="destructive">
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  ) : null
}
