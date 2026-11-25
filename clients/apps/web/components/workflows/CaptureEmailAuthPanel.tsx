'use client'

import { useCallback, useEffect, useState } from 'react'
import { ConfirmDialog } from '@/components/settings/ConfirmDialog'
import { Pill } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getErrorMessage } from '@/components/workspace/settings-client'
import {
  captureLoginRecipeSchema,
  type CaptureConnection,
  type CaptureEmailAuth,
} from '@/lib/api/contracts/capture'
import { useTRPCClient } from '@/lib/trpc/react'
import {
  ACTIVE_AUTH_ATTEMPT_STATES,
  CAPTURE_EMAIL_AUTH_STATUS,
  emailAuthFailureMessage,
  loginRecipeForm,
  loginRecipeInput,
  type LoginRecipeForm,
} from '@/lib/workflows/capture'
import { CaptureError, CaptureField, useCaptureAction } from './capture-ui'
import { automationSelectClass } from './ConditionEditor'
import { relativeTime } from './workflow-ui'

const POLL_MS = 3000

/**
 * Unattended first-factor email sign-in for one connection (RFC 007A): a
 * Shots test address, an owner-approved login recipe, a watched test, and
 * the owner's separate opt-in to automatic reconnects. No link, code, or
 * email content ever reaches this page.
 */
export function CaptureEmailAuthPanel({
  canManage,
  connection,
  onChanged,
}: {
  canManage: boolean
  connection: CaptureConnection
  onChanged: () => Promise<void>
}) {
  const client = useTRPCClient()
  const [setup, setSetup] = useState<CaptureEmailAuth | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [form, setForm] = useState<LoginRecipeForm>(loginRecipeForm(null))
  const { busy, error, run } = useCaptureAction()
  const load = useCallback(async () => {
    const { emailAuth } = await client.capture.emailAuth.query({ id: connection.id })
    setSetup(emailAuth)
    setLoaded(true)
    return emailAuth
  }, [client, connection.id])
  const attempt = setup?.latestAttempt ?? null
  const running = attempt ? ACTIVE_AUTH_ATTEMPT_STATES.has(attempt.state) : false
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => {
      void load().then((next) => {
        if (next?.latestAttempt && !ACTIVE_AUTH_ATTEMPT_STATES.has(next.latestAttempt.state)) {
          void onChanged()
        }
      })
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [load, onChanged, running])
  const open = (next: boolean) => {
    if (next && !loaded) {
      void run(async () => {
        const emailAuth = await load()
        setForm(loginRecipeForm(emailAuth))
      })
    }
  }
  const set = (key: keyof LoginRecipeForm, value: string) =>
    setForm((old) => ({ ...old, [key]: value }))
  const text = (key: keyof LoginRecipeForm, label: string, hint: string, required = true) => (
    <CaptureField hint={hint} label={label}>
      <Input
        disabled={!canManage}
        onChange={(event) => set(key, event.target.value)}
        required={required}
        value={form[key]}
      />
    </CaptureField>
  )
  const create = () =>
    run(async () => {
      const { emailAuth } = await client.capture.createEmailAuth.mutate({ id: connection.id })
      setSetup(emailAuth)
      setForm(loginRecipeForm(emailAuth))
    })
  const save = () =>
    run(async () => {
      if (!setup) return
      const { recipe, expectedSenders } = loginRecipeInput(form)
      const parsed = captureLoginRecipeSchema.safeParse(recipe)
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Check this form.')
      const { emailAuth } = await client.capture.saveEmailAuthRecipe.mutate({
        expectedRevision: setup.revision,
        expectedSenders,
        id: connection.id,
        recipe: parsed.data,
      })
      setSetup(emailAuth)
    })
  const test = () =>
    run(async () => {
      await client.capture.testEmailAuth.mutate({ id: connection.id })
      await load()
    })
  const enable = () =>
    run(async () => {
      if (!setup) return
      const { emailAuth } = await client.capture.enableEmailAuth.mutate({
        expectedRevision: setup.revision,
        id: connection.id,
      })
      setSetup(emailAuth)
    })
  const pause = () =>
    run(async () => {
      const { emailAuth } = await client.capture.pauseEmailAuth.mutate({ id: connection.id })
      setSetup(emailAuth)
    })
  const cancel = () =>
    run(async () => {
      if (!attempt) return
      await client.capture.cancelAuthAttempt.mutate({ id: attempt.id })
      await load()
    })
  const tested = setup ? setup.testedRevision === setup.revision : false
  const status = setup ? CAPTURE_EMAIL_AUTH_STATUS[setup.status] : null
  const repurposable = connection.identitySelector !== '' && !connection.expectedAccount.includes('@')
  return (
    <Disclosure className="rounded-md border p-3" onOpenChange={open}>
      <DisclosureTrigger
        summary={
          status ? (
            <span className="flex gap-1.5">
              <Pill tone={status.tone}>{status.label}</Pill>
              {setup?.autoReconnect ? <Pill tone="green">Automatic</Pill> : null}
            </span>
          ) : null
        }
      >
        <span className="text-sm font-medium">Automatic email sign-in</span>
      </DisclosureTrigger>
      <DisclosureContent className="space-y-4 pt-3">
        {!loaded ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !setup ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Shots can sign in by itself with a one-time link or code that the app emails to a
              Shots test address. It never stores a password and never handles SSO, MFA, or
              CAPTCHA: those still need a person.
            </p>
            {canManage && repurposable && connection.status !== 'REVOKED' ? (
              <Button disabled={busy} onClick={() => void create()} type="button" variant="outline">
                Get a test email address
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                To use email sign-in, add a new connection and choose a Shots test email address.
                This connection expects another account.
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <p className="text-sm">
                Test address: <span className="font-mono">{setup.testEmail}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                Create a dedicated account with this exact email in your app, with the least access
                that still shows the screens. Shots reads only sign-in emails sent to it.
              </p>
              {setup.lastSuccessAt ? (
                <p className="text-xs text-muted-foreground">
                  Last signed in {relativeTime(setup.lastSuccessAt)}
                </p>
              ) : null}
              {setup.autoReconnect && setup.approvedAt ? (
                <p className="text-xs text-muted-foreground">
                  Automatic sign-in turned on {relativeTime(setup.approvedAt)}. It renews a session
                  for up to 30 days after a person last signed in.
                </p>
              ) : null}
            </div>
            {attempt ? (
              <div className="rounded-md bg-muted/40 p-3 text-sm" role="status">
                <p>
                  {attempt.mode === 'TEST' ? 'Test' : 'Automatic sign-in'}: {attempt.safeMessage}
                </p>
                {attempt.failureCode ? (
                  <p className="text-destructive">{emailAuthFailureMessage(attempt.failureCode)}</p>
                ) : null}
                {running && canManage ? (
                  <Button
                    className="mt-2"
                    disabled={busy}
                    onClick={() => void cancel()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Stop
                  </Button>
                ) : null}
              </div>
            ) : null}
            {setup.status !== 'REVOKED' ? (
              <form
                className="space-y-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  void save()
                }}
              >
                <div className="grid gap-3 md:grid-cols-2">
                  <CaptureField hint="What the app emails." label="Sign-in method">
                    <Select
                      disabled={!canManage}
                      onValueChange={(next) => set('method', next)}
                      value={form.method}
                    >
                      <SelectTrigger className={automationSelectClass}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="MAGIC_LINK">Magic link</SelectItem>
                        <SelectItem value="EMAIL_CODE">Email code</SelectItem>
                      </SelectContent>
                    </Select>
                  </CaptureField>
                  {text('startPath', 'Sign-in page', 'A path on the app, such as /login.')}
                  {text('emailInput', 'Email field', 'CSS selector: [data-testid=login-email].')}
                  {text('requestChallenge', 'Send button', 'CSS selector of the button that sends the email.')}
                  {text(
                    'challengeConfirmation',
                    'Confirmation (optional)',
                    'CSS selector shown after sending, such as a “Check your email” panel.',
                    false
                  )}
                  {text(
                    'submitPaths',
                    'Form submit paths',
                    'The only paths sign-in may POST to, separated by commas: /api/auth/email.'
                  )}
                  {form.method === 'MAGIC_LINK' ? (
                    <>
                      {text('linkHosts', 'Link hosts', 'Exact hosts the link may use: auth.example.com.')}
                      {text('linkPaths', 'Link paths', 'Exact paths the link may use: /auth/callback.')}
                    </>
                  ) : (
                    <>
                      {text('codeInput', 'Code field', 'CSS selector of one field or of each digit field.')}
                      {text('codeLength', 'Code length', '4 to 10 digits.')}
                      {text(
                        'submitCode',
                        'Code button (optional)',
                        'Without it, Shots presses Enter.',
                        false
                      )}
                    </>
                  )}
                  {text(
                    'expectedSenders',
                    'Senders',
                    'The address or @domain the sign-in email comes from, separated by commas.'
                  )}
                </div>
                {canManage ? (
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={busy} type="submit" variant="outline">
                      Save recipe
                    </Button>
                    <Button
                      disabled={busy || running || !setup.recipe}
                      onClick={() => void test()}
                      type="button"
                      variant="outline"
                    >
                      Test sign-in
                    </Button>
                    {setup.autoReconnectAvailable && !setup.autoReconnect ? (
                      <Button disabled={busy || !tested} onClick={() => void enable()} type="button">
                        Turn on automatic sign-in
                      </Button>
                    ) : null}
                    {setup.autoReconnect || running ? (
                      <Button disabled={busy} onClick={() => void pause()} type="button" variant="outline">
                        Pause
                      </Button>
                    ) : null}
                    <ConfirmDialog
                      confirmLabel="Remove"
                      description="The test address stops receiving sign-in emails and any running sign-in stops. The saved session stays until it expires."
                      destructive
                      onConfirm={async () => {
                        try {
                          await client.capture.revokeEmailAuth.mutate({ id: connection.id })
                          await load()
                          return null
                        } catch (failure) {
                          return getErrorMessage(failure)
                        }
                      }}
                      title="Remove email sign-in?"
                      triggerLabel="Remove"
                    />
                  </div>
                ) : null}
                {!tested && setup.recipe ? (
                  <p className="text-xs text-muted-foreground">
                    Run a passing test of this setup before turning on automatic sign-in.
                  </p>
                ) : null}
              </form>
            ) : null}
          </>
        )}
        <CaptureError message={error} />
      </DisclosureContent>
    </Disclosure>
  )
}
