'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import {
  notificationRequest,
  useNotificationPageVisible,
  useNotificationIdentity,
} from '@/lib/notifications/client'
import { notificationDeliverySchema, type NotificationSettings } from '@/lib/notifications/schema'

/** Private delivery outcomes and explicit recovery for the current recipient. */
export function PersonalNotificationDeliveries({
  identity,
  settings,
}: {
  identity: ReturnType<typeof useNotificationIdentity>
  settings: NotificationSettings
}) {
  const visible = useNotificationPageVisible()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const deliveries = useQuery({
    queryKey: [...identity.key, 'personal-deliveries'],
    queryFn: ({ signal }) =>
      notificationRequest(
        identity,
        '/deliveries?scope=personal',
        z.object({ deliveries: z.array(notificationDeliverySchema) }),
        { signal }
      ),
    enabled: identity.ready && visible,
    refetchInterval: visible ? 15_000 : false,
    refetchIntervalInBackground: false,
  })
  async function recover(id: string, action: 'retry' | 'confirm_delivered' | 'dismiss') {
    setBusy(id)
    setError('')
    try {
      await notificationRequest(
        identity,
        `/deliveries/${encodeURIComponent(id)}/recover`,
        z.object({ recovered: z.boolean() }),
        { method: 'POST', body: { action } }
      )
      await deliveries.refetch()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The delivery could not be updated.')
    } finally {
      setBusy('')
    }
  }
  return (
    <details className="rounded-lg border border-border p-5">
      <summary className="cursor-pointer text-ui-lg font-medium">
        Your email and Slack delivery history
      </summary>
      <p className="mt-3 text-sm text-muted-foreground">
        Your latest 100 delivery decisions. Skipped alerts stay skipped when preferences change.
        Reconnect an expired Slack account above before retrying a blocked delivery. Check the
        destination before confirming an unconfirmed send.
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {deliveries.isPending ? (
        <p role="status">Loading delivery history…</p>
      ) : deliveries.error ? (
        <div role="alert">
          <p>{deliveries.error.message}</p>
          <Button variant="outline" onClick={() => void deliveries.refetch()}>
            Retry delivery history
          </Button>
        </div>
      ) : deliveries.data.deliveries.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No personal delivery history yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {deliveries.data.deliveries.map((delivery) => (
            <li className="space-y-2 py-4" key={delivery.id} aria-label={`Delivery ${delivery.id}`}>
              <p className="text-ui-lg font-medium">
                {settings.catalogue.find((event) => event.id === delivery.kind)?.label ??
                  'Test notification'}{' '}
                · {delivery.channel === 'slack_dm' ? 'Slack DM' : 'Email'}
              </p>
              <p className="text-sm">
                {delivery.status === 'UNCERTAIN'
                  ? 'Delivery unconfirmed'
                  : delivery.status.toLowerCase()}
                {delivery.failureCode
                  ? ` · ${delivery.failureCode.toLowerCase().replaceAll('_', ' ')}`
                  : ''}
              </p>
              <p className="text-xs text-muted-foreground">
                {delivery.decisionCode === 'REQUIRED_FAILURE_ALERT'
                  ? 'Required failure alert · '
                  : ''}
                <time dateTime={delivery.createdAt}>
                  {new Date(delivery.createdAt).toLocaleString()}
                </time>
              </p>
              <p className="break-all text-xs text-muted-foreground">Reference: {delivery.id}</p>
              {['BLOCKED', 'UNCERTAIN', 'DEAD'].includes(delivery.status) ? (
                <div className="flex flex-wrap gap-2">
                  {delivery.status !== 'UNCERTAIN' || delivery.channel === 'email' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!!busy}
                      onClick={() => void recover(delivery.id, 'retry')}
                    >
                      Retry safely
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => void recover(delivery.id, 'confirm_delivered')}
                  >
                    Confirm already delivered
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!busy}
                    onClick={() => void recover(delivery.id, 'dismiss')}
                  >
                    Dismiss delivery
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}
