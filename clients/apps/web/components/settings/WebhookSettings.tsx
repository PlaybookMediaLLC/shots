'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { Group, Pill, PlanRequired, Row, Section } from '@/components/platform-ui'
import { ConfirmDialog } from '@/components/settings/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { deleteWebhookContract, listWebhookDeliveriesContract, listWebhooksContract, webhookDeliverySchema, webhookEventSchema, webhookSchema, webhookWithSecretSchema } from '@/lib/api/contracts/outbound-webhooks'
import { isPlanRefusal } from '@/lib/api/platform-errors'
import { SettingsRequestError, settingsErrorMessage, settingsRequest } from '@/lib/settings/client'

type Webhook = z.output<typeof webhookSchema>
type WebhookEvent = z.infer<typeof webhookEventSchema>

const WEBHOOKS_KEY = ['webhooks'] as const

/** The events a webhook can receive, as the settings page names them. */
const EVENT_LABELS: Record<WebhookEvent, { description: string; label: string }> = {
  'draft.updated': { description: 'Draft content, title, destinations, or publishing options change.', label: 'Draft Updated' },
  'draft.created': { description: 'A new draft is created.', label: 'Draft Created' },
  'draft.deleted': { description: 'A draft is permanently deleted.', label: 'Draft Deleted' },
  'draft.planned': { description: 'A draft is planned on the calendar.', label: 'Draft Planned' },
  'draft.published': { description: 'A post from a draft is published to social media.', label: 'Draft Published' },
  'draft.scheduled': { description: 'A draft is scheduled for later publishing.', label: 'Draft Scheduled' },
  'draft.status_changed': { description: 'A draft changes status, such as draft to scheduled.', label: 'Draft Status Changed' },
  'draft.tags_changed': { description: 'Tags are added or removed.', label: 'Draft Tags Changed' },
}

const ERROR_LABELS: Record<string, string> = {
  resource_private: 'The publishing brand is private or unavailable; nothing was sent.',
  blocked_destination: 'The address resolved to a private network and was not called.',
  connection: 'The connection failed.',
  dns: 'The host name did not resolve.',
  http_status: 'The endpoint answered with an error status.',
  invalid_endpoint: 'The URL is not a valid HTTPS address.',
  redirect_refused: 'The endpoint redirected; redirects are not followed.',
  secret_unavailable: 'The signing secret could not be read on the server.',
  timeout: 'The endpoint took longer than ten seconds.',
  tls: 'The certificate could not be verified.',
}

/** Valid HTTPS URL with no credentials. The backend checks where it resolves. */
const httpsUrlSchema = z.url({ protocol: /^https$/ }).refine((value) => {
  // Refinements run even when the URL check failed, so parse without throwing.
  const url = URL.parse(value)
  return url !== null && !url.username && !url.password
})

function SecretNotice({ onDone, secret }: { onDone: () => void; secret: string }) {
  return (
    <div className="grid gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4" role="status">
      <p className="text-ui-lg font-medium text-foreground">Copy this signing secret now. It is not shown again.</p>
      <code className="break-all rounded bg-foreground/[0.06] px-2 py-1 text-xs">{secret}</code>
      <div className="flex gap-2">
        <Button
          onClick={async () => {
            await navigator.clipboard.writeText(secret)
            toast.success('Secret copied.')
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          Copy secret
        </Button>
        <Button onClick={onDone} size="sm" type="button">
          I saved it
        </Button>
      </div>
    </div>
  )
}

function AddWebhook({ onCreated }: { onCreated: (secret: string) => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<WebhookEvent[]>([])
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)
  const urlValid = httpsUrlSchema.safeParse(url.trim()).success
  const valid = name.trim().length > 0 && urlValid && events.length > 0
  const all = webhookEventSchema.options

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} type="button">
        Add webhook
      </Button>
    )
  }
  return (
    <form
      className="grid gap-4 rounded-xl border border-border p-4"
      onSubmit={async (event) => {
        event.preventDefault()
        if (!valid) return
        setSaving(true)
        try {
          const created = await settingsRequest('/api/v1/webhooks', webhookWithSecretSchema, {
            body: { events, name: name.trim(), url: url.trim() },
            method: 'POST',
          })
          await queryClient.invalidateQueries({ queryKey: WEBHOOKS_KEY })
          onCreated(created.secret)
          setName('')
          setUrl('')
          setEvents([])
          setOpen(false)
        } catch (error) {
          toast.error(settingsErrorMessage(error))
        } finally {
          setSaving(false)
        }
      }}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <Label className="grid gap-1 text-sm">
          <span className="font-medium text-foreground">Name</span>
          <Input maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Zapier" value={name} />
        </Label>
        <Label className="grid gap-1 text-sm">
          <span className="font-medium text-foreground">Webhook URL</span>
          <Input
            aria-describedby="webhook-url-hint"
            aria-invalid={url.length > 0 && !urlValid}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/hooks/shots"
            type="url"
            value={url}
          />
          <span className="text-xs text-muted-foreground" id="webhook-url-hint">
            HTTPS only, with no user name or password. Private and internal addresses are refused.
          </span>
        </Label>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 flex w-full items-center justify-between text-ui-lg font-medium text-foreground">
          Events
          <Button onClick={() => setEvents(events.length === all.length ? [] : [...all])} size="sm" type="button" variant="ghost">
            {events.length === all.length ? 'Clear all' : 'Select all'}
          </Button>
        </legend>
        {all.map((value) => (
          <Label className="flex items-start gap-2 text-sm" key={value}>
            <Checkbox
              checked={events.includes(value)}
              className="mt-0.5"
              onCheckedChange={(checked) => setEvents(checked === true ? [...events, value] : events.filter((item) => item !== value))}
            />
            <span>
              <span className="font-medium text-foreground">{EVENT_LABELS[value].label}</span>{' '}
              <code className="text-xs text-muted-foreground">{value}</code>
              <span className="block text-xs text-muted-foreground">{EVENT_LABELS[value].description}</span>
            </span>
          </Label>
        ))}
      </fieldset>
      <div className="flex gap-2">
        <Button onClick={() => setOpen(false)} type="button" variant="outline">
          Cancel
        </Button>
        <Button disabled={!valid || saving} type="submit">
          {saving ? 'Adding…' : 'Add webhook'}
        </Button>
      </div>
    </form>
  )
}

function Deliveries({ webhook }: { webhook: Webhook }) {
  const queryClient = useQueryClient()
  const key = ['webhooks', webhook.id, 'deliveries'] as const
  const deliveries = useQuery({
    queryFn: () => settingsRequest(`/api/v1/webhooks/${encodeURIComponent(webhook.id)}/deliveries`, listWebhookDeliveriesContract.output),
    queryKey: key,
    refetchInterval: 5000,
  })
  const items = deliveries.data?.items ?? []
  return (
    <div className="grid gap-2">
      {deliveries.isError ? <p className="text-sm text-red-700 dark:text-red-300">{settingsErrorMessage(deliveries.error)}</p> : null}
      {items.length === 0 && !deliveries.isPending ? <p className="text-sm text-muted-foreground">No deliveries yet.</p> : null}
      {items.length > 0 ? (
        <div className="overflow-x-auto">
          <Table className="w-full min-w-[40rem] text-left text-xs">
            <TableCaption className="sr-only">Recent deliveries to {webhook.name}</TableCaption>
            <TableHeader className="text-muted-foreground">
              <TableRow>
                <TableHead className="py-1.5 font-medium text-muted-foreground" scope="col">Event</TableHead>
                <TableHead className="py-1.5 font-medium text-muted-foreground" scope="col">State</TableHead>
                <TableHead className="py-1.5 font-medium text-muted-foreground" scope="col">Attempts</TableHead>
                <TableHead className="py-1.5 font-medium text-muted-foreground" scope="col">Response</TableHead>
                <TableHead className="py-1.5 font-medium text-muted-foreground" scope="col">Last attempt</TableHead>
                <TableHead className="py-1.5 font-medium text-muted-foreground" scope="col">Next retry</TableHead>
                <TableHead className="sr-only" scope="col">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((delivery) => (
                <TableRow className="border-t border-border align-top" key={delivery.id}>
                  <TableCell className="py-1.5 align-top">
                    <span className="block text-foreground">{delivery.eventType}</span>
                    <code className="text-muted-foreground">{delivery.eventId}</code>
                  </TableCell>
                  <TableCell className="py-1.5 align-top whitespace-normal">
                    <Pill tone={delivery.status === 'SUCCEEDED' ? 'green' : delivery.status === 'DEAD' ? 'red' : 'yellow'}>
                      {delivery.status === 'DEAD' ? 'Stopped retrying' : delivery.status.toLowerCase()}
                    </Pill>
                    {delivery.errorClass ? <span className="mt-1 block text-muted-foreground">{ERROR_LABELS[delivery.errorClass] ?? delivery.errorClass}</span> : null}
                  </TableCell>
                  <TableCell className="py-1.5 align-top">{delivery.attempts}</TableCell>
                  <TableCell className="py-1.5 align-top">{delivery.responseStatus ?? '—'}</TableCell>
                  <TableCell className="py-1.5 align-top whitespace-normal">{delivery.lastAttemptAt ? new Date(delivery.lastAttemptAt).toLocaleString() : '—'}</TableCell>
                  <TableCell className="py-1.5 align-top whitespace-normal">{delivery.nextAttemptAt ? new Date(delivery.nextAttemptAt).toLocaleString() : '—'}</TableCell>
                  <TableCell className="py-1.5 text-right align-top">
                    {delivery.status === 'DEAD' ? (
                      <Button
                        onClick={async () => {
                          try {
                            await settingsRequest(`/api/v1/webhook-deliveries/${encodeURIComponent(delivery.id)}/retry`, webhookDeliverySchema, { method: 'POST' })
                            await queryClient.invalidateQueries({ queryKey: key })
                            toast.success('Delivery queued again with the same event ID.')
                          } catch (error) {
                            toast.error(settingsErrorMessage(error))
                          }
                        }}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Retry
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  )
}

function WebhookRow({ onSecret, webhook }: { onSecret: (secret: string) => void; webhook: Webhook }) {
  const queryClient = useQueryClient()
  const [showDeliveries, setShowDeliveries] = useState(false)
  const update = async (body: { enabled: boolean }) => {
    try {
      await settingsRequest(`/api/v1/webhooks/${encodeURIComponent(webhook.id)}`, webhookSchema, { body, method: 'PATCH' })
      await queryClient.invalidateQueries({ queryKey: WEBHOOKS_KEY })
    } catch (error) {
      toast.error(settingsErrorMessage(error))
    }
  }
  return (
    <Row
      description={
        <span className="grid gap-1">
          <code className="break-all text-xs">{webhook.url}</code>
          <span>{webhook.events.map((event) => EVENT_LABELS[webhookEventSchema.catch('draft.created').parse(event)]?.label ?? event).join(', ')}</span>
          <span>
            Last success: {webhook.lastSuccessAt ? new Date(webhook.lastSuccessAt).toLocaleString() : 'never'} · Last failure:{' '}
            {webhook.lastFailureAt ? new Date(webhook.lastFailureAt).toLocaleString() : 'never'}
          </span>
          {webhook.previousSecretExpiresAt ? (
            <span>The previous secret also signs until {new Date(webhook.previousSecretExpiresAt).toLocaleString()}.</span>
          ) : null}
        </span>
      }
      label={
        <span className="flex items-center gap-2">
          {webhook.name}
          <Pill tone={webhook.enabled ? 'green' : 'gray'}>{webhook.enabled ? 'Enabled' : 'Disabled'}</Pill>
        </span>
      }
      layout="stacked"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Label className="flex items-center gap-2 text-sm">
          <Switch aria-label={`Deliver to ${webhook.name}`} checked={webhook.enabled} onCheckedChange={(enabled) => void update({ enabled })} />
          Deliver events
        </Label>
        <Button
          onClick={async () => {
            try {
              await settingsRequest(`/api/v1/webhooks/${encodeURIComponent(webhook.id)}/test`, webhookDeliverySchema, { method: 'POST' })
              setShowDeliveries(true)
              await queryClient.invalidateQueries({ queryKey: ['webhooks', webhook.id, 'deliveries'] })
              toast.success('A test delivery is on its way.')
            } catch (error) {
              toast.error(settingsErrorMessage(error))
            }
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          Send test
        </Button>
        <ConfirmDialog
          confirmLabel="Rotate secret"
          description="A new secret signs every delivery from now on. The current one keeps signing beside it for 24 hours, so you can update your receiver without missing events."
          onConfirm={async () => {
            try {
              const rotated = await settingsRequest(`/api/v1/webhooks/${encodeURIComponent(webhook.id)}/rotate`, webhookWithSecretSchema, { method: 'POST' })
              await queryClient.invalidateQueries({ queryKey: WEBHOOKS_KEY })
              onSecret(rotated.secret)
              return null
            } catch (error) {
              return settingsErrorMessage(error)
            }
          }}
          title={`Rotate the secret of ${webhook.name}?`}
          triggerLabel="Rotate secret"
        />
        <Button aria-expanded={showDeliveries} onClick={() => setShowDeliveries(!showDeliveries)} size="sm" type="button" variant="outline">
          {showDeliveries ? 'Hide deliveries' : 'Delivery history'}
        </Button>
        <ConfirmDialog
          confirmLabel="Delete webhook"
          confirmText={webhook.name}
          description="Events stop going to this endpoint, and its delivery history is deleted."
          destructive
          onConfirm={async () => {
            try {
              await settingsRequest(`/api/v1/webhooks/${encodeURIComponent(webhook.id)}`, deleteWebhookContract.output, { method: 'DELETE' })
              await queryClient.invalidateQueries({ queryKey: WEBHOOKS_KEY })
              return null
            } catch (error) {
              return settingsErrorMessage(error)
            }
          }}
          title={`Delete ${webhook.name}?`}
          triggerLabel="Delete"
        />
      </div>
      {showDeliveries ? <Deliveries webhook={webhook} /> : null}
    </Row>
  )
}

/**
 * Outbound webhooks (RFC 024): signed HTTPS deliveries of draft events to
 * your own systems, retried for a while and replayable after that.
 */
export function WebhookSettings({ canManage }: { canManage: boolean }) {
  const [secret, setSecret] = useState<string | null>(null)
  const webhooks = useQuery({
    enabled: canManage,
    queryFn: () => settingsRequest('/api/v1/webhooks', listWebhooksContract.output),
    queryKey: WEBHOOKS_KEY,
  })
  const unavailable = webhooks.error instanceof SettingsRequestError && webhooks.error.status === 503
  const planRequired = isPlanRefusal(webhooks.error)
  return (
    <Section
      description="Shots sends each event to your endpoints with an HMAC-SHA256 signature. Deliveries are at least once: use the event ID to drop repeats."
      title="Webhooks"
    >
      {!canManage ? (
        <Group>
          <Row>
            <p className="text-sm text-muted-foreground">Only workspace owners and admins can manage webhooks.</p>
          </Row>
        </Group>
      ) : (
        <div className="grid gap-4">
          {secret ? <SecretNotice onDone={() => setSecret(null)} secret={secret} /> : null}
          {planRequired ? (
            <PlanRequired from="/settings/developers">Outbound webhooks need Pro.</PlanRequired>
          ) : webhooks.isError ? (
            <p className="text-sm text-red-700 dark:text-red-300" role="alert">
              {unavailable
                ? 'Webhooks are unavailable. Contact your administrator to enable them.'
                : settingsErrorMessage(webhooks.error)}
            </p>
          ) : null}
          {unavailable ? <Disclosure className="text-xs text-muted-foreground"><DisclosureTrigger>Administrator setup details</DisclosureTrigger><DisclosureContent><p>Configure PLATFORM_WEBHOOK_ENCRYPTION_KEY on the server to protect signing secrets.</p></DisclosureContent></Disclosure> : null}
          {webhooks.data ? (
            webhooks.data.items.length > 0 ? (
              <Group>
                {webhooks.data.items.map((webhook) => (
                  <WebhookRow key={webhook.id} onSecret={setSecret} webhook={webhook} />
                ))}
              </Group>
            ) : (
              <p className="text-sm text-muted-foreground">No webhooks yet.</p>
            )
          ) : null}
          {unavailable || planRequired ? null : <AddWebhook onCreated={setSecret} />}
          <Disclosure className="rounded-xl border border-border p-4 text-sm">
            <DisclosureTrigger className="font-medium text-foreground">Verify a delivery</DisclosureTrigger>
            <DisclosureContent>
              <div className="mt-3 grid gap-2 text-muted-foreground">
                <p>
                  Each request carries <code>X-Shots-Event</code>, <code>X-Shots-Event-Id</code>, <code>X-Shots-Timestamp</code> and{' '}
                  <code>X-Shots-Signature</code>. The signature is <code>v1=</code> and the hex HMAC-SHA256, keyed with your secret, of the event
                  ID, a dot, the timestamp, a dot, and the raw body. After a rotation it lists two signatures, comma-separated; accept either.
                </p>
                <pre className="overflow-x-auto rounded bg-foreground/[0.05] p-3 text-xs text-foreground">{`const expected = 'v1=' + createHmac('sha256', secret)
    .update(\`\${eventId}.\${timestamp}.\${rawBody}\`).digest('hex')
  const ok = header.split(',').some((part) =>
    part.length === expected.length && timingSafeEqual(Buffer.from(part), Buffer.from(expected)))
  // Reject a timestamp older than five minutes, and skip an event ID you already handled.`}</pre>
                <p>Answer with any 2xx status within ten seconds. Other answers are retried for about ten hours, then stop until you retry them here.</p>
              </div>
            </DisclosureContent>
          </Disclosure>
        </div>
      )}
    </Section>
  )
}
