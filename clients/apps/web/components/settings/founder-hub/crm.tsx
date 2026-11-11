'use client'

import Nango from '@nangohq/frontend'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  founderHubCRMConnectInputSchema,
  founderHubCRMConnectSessionSchema,
  founderHubCRMConnectionsSchema,
  founderHubCRMDisconnectResultSchema,
  founderHubCRMProvidersSchema,
  founderHubCRMRegisterInputSchema,
  founderHubCRMRegisterResultSchema,
} from 'screenshot-studio-backend-sdk'
import { settingsRequest, settingsErrorMessage } from '@/lib/settings/client'
import { SettingsPageTitle } from './page-title'
import { useFounderHubUserId } from './settings-context'

export function SettingsCRM() {
  const userId = useFounderHubUserId()
  const client = useQueryClient()
  const [pendingSession, setPendingSession] = useState<{
    provider: string
    connectionId?: string
    token: string
    expiresAt: string
    apiURL: string
    connectURL: string
  }>()
  const [authError, setAuthError] = useState<string>()
  const [authPending, setAuthPending] = useState(false)
  const authInFlight = useRef(false)
  const authorizationAttempt = useRef(0)
  const connectUI = useRef<ReturnType<Nango['openConnectUI']> | null>(null)
  useEffect(
    () => () => {
      authorizationAttempt.current += 1
      connectUI.current?.close()
    },
    []
  )
  const providers = useQuery({
    queryKey: ['founder-hub-crm-providers'],
    queryFn: ({ signal }) =>
      settingsRequest('/api/founder-hub/crm/providers', founderHubCRMProvidersSchema, { signal }),
    staleTime: Infinity,
  })
  const connections = useQuery({
    queryKey: ['founder-hub-crm-connections', userId],
    queryFn: ({ signal }) =>
      settingsRequest('/api/founder-hub/crm/connections', founderHubCRMConnectionsSchema, {
        signal,
      }),
  })
  const connect = useMutation({
    mutationFn: async (input: { provider: string; connectionId?: string }) => {
      const payload = founderHubCRMConnectInputSchema.parse({
        provider: input.provider,
        mode: input.connectionId ? 'reconnect' : 'connect',
        ...(input.connectionId ? { connection_id: input.connectionId } : {}),
      })
      return settingsRequest('/api/founder-hub/crm/session', founderHubCRMConnectSessionSchema, {
        method: 'POST',
        body: payload,
      })
    },
    onSuccess: (session, input) => {
      setAuthError(undefined)
      setPendingSession({
        ...input,
        token: session.token,
        expiresAt: session.expires_at,
        apiURL: session.api_url,
        connectURL: session.connect_url,
      })
    },
  })
  const disconnect = useMutation({
    mutationFn: ({ provider, connectionId }: { provider: string; connectionId: string }) =>
      settingsRequest(
        `/api/founder-hub/crm/connections/${encodeURIComponent(connectionId)}?provider=${encodeURIComponent(provider)}`,
        founderHubCRMDisconnectResultSchema,
        { method: 'DELETE' }
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['founder-hub-crm-connections', userId] })
    },
  })

  return (
    <div className="flex flex-col gap-6">
      <SettingsPageTitle title="CRM" />
      <p className="text-sm text-muted-foreground">
        Connect a CRM to use its contacts with Founder Hub. Connections are scoped to your Shots
        account.
      </p>
      {(providers.error || connections.error || connect.error || disconnect.error || authError) && (
        <p role="alert" className="text-sm text-destructive">
          {authError ??
            settingsErrorMessage(
              providers.error ?? connections.error ?? connect.error ?? disconnect.error
            )}
        </p>
      )}
      {pendingSession && (
        <p className="text-sm text-muted-foreground">
          Connect session ready. Continue to open the provider authorization window.
        </p>
      )}
      {providers.data && !providers.data.configured && (
        <p role="status" className="text-sm text-muted-foreground">
          CRM providers are not configured for this Shots environment.
        </p>
      )}
      {providers.isPending || connections.isPending ? (
        <p role="status">Loading CRM connections…</p>
      ) : providers.data && connections.data ? (
        <ul className="flex flex-col divide-y rounded-md border">
          {providers.data.providers.map((provider) => {
            const owned = connections.data.connections.filter(
              (item) => item.integration_id === provider.id
            )
            return (
              <li
                key={provider.id}
                className="flex flex-wrap items-center justify-between gap-3 p-4"
              >
                <div>
                  <h3 className="font-medium">{provider.name}</h3>
                  {owned.length > 0 ? (
                    <ul className="mt-1 flex flex-col gap-1 text-xs text-muted-foreground">
                      {owned.map((connection) => (
                        <li key={connection.connection_id}>
                          {connection.status === 'reconnect_required'
                            ? 'Reconnect required'
                            : 'Connected'}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">Not connected</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {owned.map((connection) => (
                    <span key={connection.connection_id} className="flex gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={
                          !providers.data.configured ||
                          connect.isPending ||
                          disconnect.isPending ||
                          authPending
                        }
                        onClick={() =>
                          pendingSession?.provider === provider.id &&
                          pendingSession.connectionId === connection.connection_id
                            ? openAuthorization()
                            : connect.mutate({
                                provider: provider.id,
                                connectionId: connection.connection_id,
                              })
                        }
                      >
                        {pendingSession?.provider === provider.id &&
                        pendingSession.connectionId === connection.connection_id
                          ? 'Continue to reconnect'
                          : 'Reconnect'}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={
                          !providers.data.configured ||
                          connect.isPending ||
                          disconnect.isPending ||
                          authPending
                        }
                        onClick={() =>
                          disconnect.mutate({
                            provider: provider.id,
                            connectionId: connection.connection_id,
                          })
                        }
                      >
                        Disconnect
                      </Button>
                    </span>
                  ))}
                  <Button
                    type="button"
                    disabled={
                      !providers.data.configured ||
                      connect.isPending ||
                      disconnect.isPending ||
                      authPending
                    }
                    onClick={() =>
                      pendingSession?.provider === provider.id && !pendingSession.connectionId
                        ? openAuthorization()
                        : connect.mutate({ provider: provider.id })
                    }
                  >
                    {pendingSession?.provider === provider.id && !pendingSession.connectionId
                      ? `Continue to ${provider.name}`
                      : `Connect ${provider.name}`}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )

  function openAuthorization() {
    if (!pendingSession || authInFlight.current) return
    if (Date.parse(pendingSession.expiresAt) <= Date.now()) {
      setPendingSession(undefined)
      setAuthError('The connection session expired. Start the connection again.')
      return
    }
    setAuthError(undefined)
    authInFlight.current = true
    setAuthPending(true)
    const attempt = ++authorizationAttempt.current
    let completed = false
    const finishAuthorization = () => {
      if (authorizationAttempt.current !== attempt) return
      authorizationAttempt.current += 1
      authInFlight.current = false
      setAuthPending(false)
      connectUI.current = null
    }
    const ui = new Nango().openConnectUI({
      sessionToken: pendingSession.token,
      apiURL: pendingSession.apiURL,
      baseURL: pendingSession.connectURL,
      detectClosedAuthWindow: true,
      onEvent: async (event) => {
        if (event.type === 'connect') {
          try {
            const registration = founderHubCRMRegisterInputSchema.parse({
              provider: event.payload.providerConfigKey,
              connection_id: event.payload.connectionId,
            })
            await settingsRequest(
              '/api/founder-hub/crm/connections',
              founderHubCRMRegisterResultSchema,
              {
                method: 'POST',
                body: registration,
              }
            )
            completed = true
            if (authorizationAttempt.current !== attempt) return
            setPendingSession(undefined)
            await client.invalidateQueries({ queryKey: ['founder-hub-crm-connections', userId] })
            if (authorizationAttempt.current !== attempt) return
            ui.close()
            finishAuthorization()
          } catch (error: unknown) {
            if (authorizationAttempt.current !== attempt) return
            setPendingSession(undefined)
            setAuthError(settingsErrorMessage(error))
            ui.close()
            finishAuthorization()
          }
        } else if (event.type === 'error') {
          if (authorizationAttempt.current !== attempt) return
          setPendingSession(undefined)
          setAuthError(event.payload.errorMessage)
          ui.close()
          finishAuthorization()
        } else if (event.type === 'close') {
          if (authorizationAttempt.current !== attempt) return
          if (!completed) setPendingSession(undefined)
          finishAuthorization()
        }
      },
    })
    connectUI.current = ui
  }
}
