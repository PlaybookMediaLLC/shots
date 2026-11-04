'use client'

import { useQueryClient } from '@tanstack/react-query'
import { CheckIcon as Check } from '@phosphor-icons/react/dist/ssr/Check'
import { ArrowSquareOutIcon as ExternalLink } from '@phosphor-icons/react/dist/ssr/ArrowSquareOut'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { z } from 'zod'
import {
  blueskyConnectionBeginSchema,
  blueskyConnectionBeginResponseSchema,
  blueskyConnectionCompleteSchema,
  blueskyConnectionCompleteResponseSchema,
} from 'screenshot-studio-backend-sdk'
import { useSocialSetScope } from '@/components/settings/social-sets/scope'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { settingsErrorMessage } from '@/lib/settings/client'
import type { ConnectionLauncherProps } from './ConnectionLauncher'

/** App passwords live only in the form and its POST; recovery sends state alone. */
export function BlueskyForm({
  intent,
  target,
}: Pick<ConnectionLauncherProps, 'intent' | 'target'>) {
  const scope = useSocialSetScope()
  const queryClient = useQueryClient()
  const router = useRouter()
  const id = useId()
  const [handle, setHandle] = useState('')
  const [password, setPassword] = useState('')
  const [attempt, setAttempt] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [completed, setCompleted] = useState<z.output<
    typeof blueskyConnectionCompleteResponseSchema
  > | null>(null)
  const inFlight = useRef(false)
  const lifetime = useRef<AbortController | null>(null)
  useLayoutEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => {
      controller.abort()
      lifetime.current = null
    }
  }, [])
  const credentials = blueskyConnectionCompleteSchema.shape.credentials.safeParse({
    handle,
    appPassword: password,
  })

  async function connect(recover: boolean) {
    const controller = lifetime.current
    if (!controller || inFlight.current || !scope.ready || (!recover && !credentials.success))
      return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      let state = attempt
      if (!recover) {
        const result = await scope.request(
          '/api/v1/bluesky-connection-attempts',
          blueskyConnectionBeginResponseSchema,
          {
            method: 'POST',
            body: blueskyConnectionBeginSchema.parse(intent),
            signal: controller.signal,
          }
        )
        state = result.state
        setAttempt(state)
      }
      if (!state || controller.signal.aborted) return
      const body = blueskyConnectionCompleteSchema.parse({
        state,
        ...(!recover ? { credentials: { handle, appPassword: password } } : {}),
      })
      setPassword('')
      const result = await scope.request(
        '/api/v1/bluesky-connection-attempts/connect',
        blueskyConnectionCompleteResponseSchema,
        {
          method: 'POST',
          body,
          signal: controller.signal,
        }
      )
      if (controller.signal.aborted) return
      if (result.organizationId !== scope.workspaceId) {
        setError('The account connected in its original workspace. Open that workspace to view it.')
        return
      }
      setCompleted(result)
      await queryClient.invalidateQueries({ queryKey: scope.key })
      if (!controller.signal.aborted) router.refresh()
    } catch (cause) {
      if (!controller.signal.aborted) setError(settingsErrorMessage(cause))
    } finally {
      inFlight.current = false
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  if (completed)
    return (
      <div className="grid gap-3 py-2" role="status">
        <Check aria-hidden className="size-6" />
        <p className="font-medium">Bluesky connected</p>
        <p className="text-sm text-muted-foreground">
          Your account is connected in the publishing brand you chose. Your current page is
          preserved.
        </p>
        <Button asChild>
          <Link href={completed.returnPath || '/settings/publishing-brands'}>Open publishing brand</Link>
        </Button>
      </div>
    )

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void connect(false)
      }}
    >
      <p className="text-sm leading-relaxed text-muted-foreground">
        Use your full handle and a dedicated app password from Bluesky Settings → Privacy and
        security → App passwords.
      </p>
      <a
        className="inline-flex items-center gap-1 text-sm underline underline-offset-4"
        href="https://bsky.app/settings/app-passwords"
        target="_blank"
        rel="noreferrer"
      >
        Create an app password <ExternalLink aria-hidden className="size-3.5" />
      </a>
      {intent.operation === 'RECONNECT' ? (
        <p className="text-sm text-muted-foreground">
          Use the same account connected to {target?.name ?? 'this publishing brand'}. Its drafts
          and schedule stay attached.
        </p>
      ) : null}
      {!attempt ? (
        <>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-handle`}>Handle</Label>
            <Input
              id={`${id}-handle`}
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              placeholder="name.bsky.social"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={256}
              disabled={busy}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor={`${id}-password`}>App Password</Label>
            <Input
              id={`${id}-password`}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="xxxx-xxxx-xxxx-xxxx"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={19}
              disabled={busy}
              aria-describedby={`${id}-password-help`}
              required
            />
            <p id={`${id}-password-help`} className="text-xs text-muted-foreground">
              Use a dedicated app password. Keep your main account password private.
            </p>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          The password was submitted once. You can check the saved result without sending it again.
        </p>
      )}
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {attempt ? (
        <>
          <Button
            className="w-full"
            type="button"
            disabled={busy || !scope.ready}
            onClick={() => void connect(true)}
          >
            {busy ? 'Checking connection…' : 'Check connection result'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setAttempt(null)
              setError('')
              setPassword('')
            }}
          >
            Start a new attempt
          </Button>
        </>
      ) : (
        <Button
          className="w-full"
          type="submit"
          disabled={busy || !scope.ready || !credentials.success}
        >
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
      )}
    </form>
  )
}
