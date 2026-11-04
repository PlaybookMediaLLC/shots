'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import { ArrowUpRightIcon as ArrowUpRight } from '@phosphor-icons/react/dist/ssr/ArrowUpRight'
import { CheckIcon as Check } from '@phosphor-icons/react/dist/ssr/Check'
import { Button } from '@/components/ui/button'
import { useHydratedSession } from '@/lib/auth/client'
import { activateOrganizationContract } from '@/lib/api/contracts/shell'
import { settingsErrorMessage, settingsRequest } from '@/lib/settings/client'
import {
  socialOAuthCompletedPath,
  type socialOAuthCompletionViewSchema,
} from '@/lib/tenant/social-oauth-completion'

/** Opening the original workspace is an explicit action; authorization never retargets the account. */
export function ConnectionCompletion(props: z.output<typeof socialOAuthCompletionViewSchema>) {
  const { data: session, isPending } = useHydratedSession()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [session?.user.id, session?.session.id])
  if (isPending) return <p role="status">Checking your session…</p>
  if (session?.user.id !== props.userId || session.session.id !== props.sessionId)
    return <p role="alert">Your sign-in changed. Reload this page to check the connection.</p>

  async function openWorkspace() {
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setError(null)
    try {
      await settingsRequest(
        `/api/v1/organizations/${encodeURIComponent(props.organizationId)}/activate`,
        activateOrganizationContract.output,
        { method: 'POST', signal: controller.signal }
      )
      if (controller.signal.aborted) return
      window.location.assign(socialOAuthCompletedPath(props))
    } catch (cause) {
      if (controller.signal.aborted) return
      setError(settingsErrorMessage(cause))
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-5">
      <span className="flex size-10 items-center justify-center rounded-full border border-border">
        <Check aria-hidden className="size-5" />
      </span>
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Connection completed</h1>
        <p className="break-words text-sm leading-relaxed text-muted-foreground">
          Your account was added in{' '}
          <strong className="text-foreground">{props.workspaceName}</strong>, where you started
          authorization. You’re currently viewing another workspace.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button disabled={busy} onClick={() => void openWorkspace()}>
        <span className="truncate">
          {busy ? 'Opening workspace…' : `Open ${props.workspaceName}`}
        </span>
        <ArrowUpRight aria-hidden className="size-4" />
      </Button>
      <Link
        className="text-center text-sm text-muted-foreground underline underline-offset-4"
        href="/settings/publishing-brands"
      >
        Stay in the current workspace
      </Link>
    </div>
  )
}
