'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useState } from 'react'
import { toast } from 'sonner'
import { LocalTime, WHEN_STYLE } from '@/components/drafts/local-time'
import { Row } from '@/components/platform-ui'
import { ConfirmDialog } from '@/components/settings/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { revokeAllSessionsResultSchema } from '@/lib/api/contracts/settings-platform'
import { authClient, useHydratedSession } from '@/lib/auth/client'
import { settingsErrorMessage, settingsRequest } from '@/lib/settings/client'

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

/**
 * Shared session list and "Sign out all devices" controls rendered on both
 * Security (`/settings/security`, for every auth provider) and Account
 * (`/settings/account`).
 */
export function SessionControls({
  reauthenticateCallback = '/settings/security',
  showSignOutCurrent = true,
}: {
  reauthenticateCallback?: string
  showSignOutCurrent?: boolean
}) {
  const [requested, setRequested] = useState(false)
  const [revokingToken, setRevokingToken] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)
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
    if (revokingToken) return
    setRevokingToken(token)
    try {
      const { error } = await authClient.revokeSession({ token })
      if (error) {
        toast.error(error.message ?? 'The session could not be signed out.')
        return
      }
      toast.success('That device is signed out.')
      await queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] })
    } catch (error) {
      toast.error(settingsErrorMessage(error))
    } finally {
      setRevokingToken(null)
    }
  }

  const revokeAll = async (): Promise<string | null> => {
    try {
      await settingsRequest('/api/v1/me/sessions/revoke-all', revokeAllSessionsResultSchema, {
        method: 'POST',
      })
      window.location.assign('/sign-in?signedOut=everywhere')
      return null
    } catch (error) {
      return settingsErrorMessage(error)
    }
  }

  const isNotFresh =
    sessions.isError && 'code' in sessions.error && sessions.error.code === 'SESSION_NOT_FRESH'

  return (
    <>
      <Row description="Devices signed in to your account." label="Active sessions" layout="stacked">
        {!requested ? (
          <Button variant="outline" onClick={() => setRequested(true)} type="button">
            View signed-in devices
          </Button>
        ) : null}
        {requested && sessions.isPending ? (
          <p className="text-sm text-muted-foreground">Loading sessions…</p>
        ) : null}
        {sessions.isError ? (
          <div className="grid gap-2">
            <p
              className={
                isNotFresh
                  ? 'text-sm text-muted-foreground'
                  : 'text-sm text-red-700 dark:text-red-300'
              }
              role={isNotFresh ? 'status' : 'alert'}
            >
              {isNotFresh
                ? 'Confirm your sign-in to view and manage your sessions.'
                : settingsErrorMessage(sessions.error)}
            </p>
            <div className="flex gap-2">
              <Button asChild variant="outline">
                <Link
                  href={`/sign-in?reauthenticate=1&callbackURL=${encodeURIComponent(reauthenticateCallback)}`}
                >
                  Verify identity
                </Link>
              </Button>
              {!isNotFresh ? (
                <Button
                  disabled={sessions.isFetching}
                  onClick={() => void sessions.refetch()}
                  type="button"
                  variant="outline"
                >
                  Retry
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {sessions.data && sessions.data.length > 0 ? (
          <ul className="grid gap-2">
            {sessions.data.map((session) => {
              const isCurrent = session.id === current?.session.id
              const isRevoking = revokingToken === session.token
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
                      Signed in <LocalTime options={WHEN_STYLE} value={session.createdAt} />
                      {isCurrent ? ' · This device' : ''}
                    </span>
                  </span>
                  {isCurrent ? null : (
                    <Button
                      disabled={revokingToken !== null}
                      onClick={() => void revoke(session.token)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      {isRevoking ? 'Signing out…' : 'Sign out'}
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        ) : null}
      </Row>
      <Row
        description="Sign out from all browsers, phones, and connected OAuth clients at once. You will need to sign in again."
        label="Sign out all devices"
      >
        <div className="flex flex-wrap gap-2">
          {showSignOutCurrent ? (
            <Button
              disabled={signingOut}
              onClick={async () => {
                if (signingOut) return
                setSigningOut(true)
                try {
                  const { error } = await authClient.signOut()
                  if (error) {
                    setSigningOut(false)
                    toast.error(error.message ?? 'Could not sign out.')
                    return
                  }
                  window.location.assign('/sign-in')
                } catch (error) {
                  setSigningOut(false)
                  toast.error(settingsErrorMessage(error))
                }
              }}
              type="button"
              variant="outline"
            >
              {signingOut ? 'Signing out…' : 'Sign out'}
            </Button>
          ) : null}
          <ConfirmDialog
            confirmLabel="Sign out all devices"
            description="Every browser session and connected OAuth token for your account, including this device, will be revoked immediately. You will need to sign in again."
            destructive
            disabled={signingOut}
            onConfirm={revokeAll}
            title="Sign out of all devices?"
            triggerLabel="Sign out all devices"
          />
        </div>
      </Row>
    </>
  )
}
