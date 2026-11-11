'use client'

import { platformHref, safeReturnPath } from '@/lib/platform/navigation'

import Link from 'next/link'
import { type FormEvent, useEffect, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { z } from 'zod'
import { authClient } from '@/lib/auth/client'
import { authPageSearch, authRedirect } from '@/lib/auth/oauth-navigation'
import { getAuthErrorMessage } from './error-message'
import { AuthField, FormAlert, SubmitButton } from './fields'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'

const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the six-digit code.')
const backupCodeSchema = z.string().trim().min(1, 'Enter a recovery code.')

function getCallbackUrl(value: string | null): string {
  return safeReturnPath(value)
}

export function TwoFactorForm() {
  const searchParams = useSearchParams()
  const pathname = usePathname()
  const [error, setError] = useState<string | null>(null)
  const [isHydrated, setIsHydrated] = useState(false)
  const [isBackupCode, setIsBackupCode] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [trustDevice, setTrustDevice] = useState(false)
  const callbackURL = platformHref(pathname, getCallbackUrl(searchParams.get('callbackURL')))

  useEffect(() => {
    setIsHydrated(true)
  }, [])

  async function verifyCode(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError(null)
    const code = (isBackupCode ? backupCodeSchema : totpCodeSchema).safeParse(
      new FormData(event.currentTarget).get('code')
    )
    if (!code.success) {
      setError(code.error.issues[0]?.message ?? 'Enter a valid verification code.')
      return
    }

    setIsSubmitting(true)
    try {
      const result = isBackupCode
        ? await authClient.twoFactor.verifyBackupCode({ code: code.data, trustDevice })
        : await authClient.twoFactor.verifyTotp({ code: code.data, trustDevice })
      if (result.error) throw new Error(result.error.message ?? 'Verification failed.')
      window.location.assign(authRedirect(result.data, callbackURL))
    } catch (requestError) {
      setError(getAuthErrorMessage(requestError, 'Verification failed. Try again.'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const inputLabel = isBackupCode ? 'Recovery code' : 'Authenticator code'
  return (
    <form className="space-y-5" onSubmit={verifyCode}>
      <AuthField
        autoComplete="one-time-code"
        autoFocus
        className="font-mono tracking-[0.3em]"
        id="two-factor-code"
        inputMode={isBackupCode ? 'text' : 'numeric'}
        label={inputLabel}
        name="code"
        placeholder={isBackupCode ? undefined : '123456'}
        required
      />
      <Label className="flex items-center gap-2.5 text-sm text-muted-foreground">
        <Checkbox
          checked={trustDevice}
          className="size-4 rounded accent-foreground"
          disabled={!isHydrated}
          onCheckedChange={(checked) => setTrustDevice(checked === true)}
        />
        Trust this device for 30 days
      </Label>
      {error ? <FormAlert>{error}</FormAlert> : null}
      <SubmitButton busy={isSubmitting} busyLabel="Verifying…" disabled={!isHydrated}>
        Verify and sign in
      </SubmitButton>
      <div className="flex items-center justify-between text-sm">
        <Button
          variant="custom"
          size={null}
          className="font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50"
          disabled={!isHydrated}
          onClick={() => setIsBackupCode((value) => !value)}
          type="button"
        >
          {isBackupCode ? 'Use an authenticator code' : 'Use a recovery code'}
        </Button>
        <Link
          className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          href={`/sign-in?${authPageSearch(searchParams.toString(), callbackURL)}`}
        >
          Back to sign in
        </Link>
      </div>
    </form>
  )
}
