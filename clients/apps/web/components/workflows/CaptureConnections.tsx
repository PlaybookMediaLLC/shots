'use client'

import { useState } from 'react'
import { ConfirmDialog } from '@/components/settings/ConfirmDialog'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
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
  captureConnectionInputSchema,
  captureEnvironmentSchema,
  type CaptureConnection,
  type CaptureConnectStart,
} from '@/lib/api/contracts/capture'
import { captureFailureMessage } from '@/lib/tenant/surface-freshness'
import { useTRPCClient } from '@/lib/trpc/react'
import {
  CAPTURE_CONNECTION_STATUS,
  CAPTURE_ENVIRONMENTS,
  captureConnectionInput,
  type CaptureConnectionForm,
} from '@/lib/workflows/capture'
import { CaptureError, CaptureField, useCaptureAction } from './capture-ui'
import { SignInPanel } from './CaptureSignInPanel'
import { automationSelectClass } from './ConditionEditor'
import { relativeTime } from './workflow-ui'

/** Radix selects cannot hold an empty value. */
const EMPTY_OPTION = '__empty_option__'

const blankConnection: CaptureConnectionForm = {
  environment: 'production',
  expectedAccount: '',
  hosts: '',
  identitySelector: '',
  loginHosts: '',
  name: '',
  origin: '',
  protectedPath: '',
  sourceAppId: '',
}

function ConnectionRow({
  canManage,
  connection,
  onChanged,
  sourceName,
}: {
  canManage: boolean
  connection: CaptureConnection
  onChanged: () => Promise<void>
  sourceName?: string
}) {
  const client = useTRPCClient()
  // The sign-in link is a bearer credential: it lives here only, and goes when finished.
  const [start, setStart] = useState<CaptureConnectStart | null>(null)
  const { busy, error, run } = useCaptureAction()
  const status = CAPTURE_CONNECTION_STATUS[connection.status]
  const finishing = connection.connectPhase === 'FINISHING'
  const connect = () =>
    run(async () => setStart(await client.capture.connect.mutate({ id: connection.id })))
  const finish = (intentId: string) =>
    run(async () => {
      await client.capture.finishConnect.mutate({ id: connection.id, intentId })
      setStart(null)
      await onChanged()
    })
  return (
    <Row>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-ui-lg text-foreground">{connection.name}</h3>
            <Pill tone={status.tone}>{status.label}</Pill>
            <Pill>{CAPTURE_ENVIRONMENTS[connection.environment]}</Pill>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {connection.origin} · {sourceName ?? 'No repository'} · {connection.expectedAccount}
          </p>
          {connection.validatedAt ? (
            <p className="text-xs text-muted-foreground">
              Session checked {relativeTime(connection.validatedAt)}
            </p>
          ) : null}
        </div>
        {canManage && connection.status !== 'REVOKED' ? (
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || finishing}
              onClick={() => void connect()}
              type="button"
              variant="outline"
            >
              {connection.status === 'CONNECTING' && !start ? 'Connect' : 'Reconnect'}
            </Button>
            <ConfirmDialog
              confirmLabel="Revoke"
              description="Deletes the stored session and cancels this connection's waiting captures. Signing in again needs a new connection."
              destructive
              onConfirm={async () => {
                try {
                  await client.capture.revokeConnection.mutate({ id: connection.id })
                  setStart(null)
                  await onChanged()
                  return null
                } catch (failure) {
                  return getErrorMessage(failure)
                }
              }}
              title={`Revoke “${connection.name}”?`}
              triggerLabel="Revoke"
            />
          </div>
        ) : null}
      </div>
      {start ? (
        <SignInPanel busy={busy} onFinish={() => void finish(start.intentId)} start={start} />
      ) : null}
      {finishing ? (
        <p className="text-sm text-muted-foreground" role="status">
          Checking this sign-in. Saying you signed in is not proof it worked: a worker first
          restores the session in a fresh browser and checks the account. This updates on its own.
        </p>
      ) : null}
      {connection.failureCode && !finishing ? (
        <p className="text-sm text-destructive">{captureFailureMessage(connection.failureCode)}</p>
      ) : null}
      <CaptureError message={error} />
    </Row>
  )
}

function ConnectionForm({
  onChanged,
  sources,
}: {
  onChanged: () => Promise<void>
  sources: { id: string; name: string }[]
}) {
  const client = useTRPCClient()
  const [form, setForm] = useState(blankConnection)
  const { busy, error, run } = useCaptureAction()
  const set = (key: keyof CaptureConnectionForm, value: string) =>
    setForm((old) => ({ ...old, [key]: value }))
  const text = (key: keyof CaptureConnectionForm, label: string, hint: string, required = true) => (
    <CaptureField hint={hint} label={label}>
      <Input
        onChange={(event) => set(key, event.target.value)}
        required={required}
        value={form[key]}
      />
    </CaptureField>
  )
  const submit = () =>
    run(async () => {
      const input = captureConnectionInputSchema.safeParse(captureConnectionInput(form))
      if (!input.success) throw new Error(input.error.issues[0]?.message ?? 'Check this form.')
      await client.capture.createConnection.mutate(input.data)
      setForm(blankConnection)
      await onChanged()
    })
  return (
    <form
      className="space-y-4 rounded-lg border p-5"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <h3 className="font-medium">Add a connection</h3>
      <p className="text-sm text-muted-foreground">
        Use a dedicated demo account with the least access that still shows the screens. Anyone who
        can run a capture sees what this account sees.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {text('name', 'Name', 'Shown in this workspace only.')}
        <CaptureField
          hint="Captures after a deployment run only for this environment."
          label="Environment"
        >
          <Select
            onValueChange={(next) => set('environment', next === EMPTY_OPTION ? '' : next)}
            value={form.environment || EMPTY_OPTION}
          >
            <SelectTrigger className={automationSelectClass}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {captureEnvironmentSchema.options.map((environment) => (
                <SelectItem key={environment} value={environment}>
                  {CAPTURE_ENVIRONMENTS[environment]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CaptureField>
        <CaptureField hint="Whose deployments this connection captures." label="Repository">
          <Select
            onValueChange={(next) => set('sourceAppId', next === EMPTY_OPTION ? '' : next)}
            value={form.sourceAppId || EMPTY_OPTION}
          >
            <SelectTrigger className={automationSelectClass}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={EMPTY_OPTION}>None: test and manual captures only</SelectItem>
              {sources.map((source) => (
                <SelectItem key={source.id} value={source.id}>
                  {source.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CaptureField>
        {text('origin', 'App address', 'https://app.example.com, with no path.')}
        {text(
          'hosts',
          'Approved hosts',
          'The app, its API and its CDN, separated by commas. app.example.com or *.example.com.'
        )}
        {text(
          'loginHosts',
          'Sign-in hosts',
          'Only if sign-in happens elsewhere, such as accounts.example.com.',
          false
        )}
        {text(
          'protectedPath',
          'Protected path',
          'A page only a signed-in user reaches: /settings.'
        )}
        {text(
          'identitySelector',
          'Account element',
          'The CSS selector of what shows the signed-in account: [data-testid=account-email].'
        )}
        {text(
          'expectedAccount',
          'Expected account text',
          'What that element must contain, such as demo@example.com.'
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        A connection&apos;s address and account never change: new access needs a new connection.
      </p>
      <CaptureError message={error} />
      <Button disabled={busy} type="submit">
        {busy ? 'Saving…' : 'Add connection'}
      </Button>
    </form>
  )
}

/** The apps Shots can sign in to, and the sign-in itself. */
export function CaptureConnections({
  canManage,
  connections,
  onChanged,
  sources,
}: {
  canManage: boolean
  connections: CaptureConnection[]
  onChanged: () => Promise<void>
  sources: { id: string; name: string }[]
}) {
  return (
    <Section
      title="Connections"
      description="A person signs in once in an isolated browser. Shots keeps the encrypted session, never the password."
    >
      {connections.length === 0 ? (
        <p className="text-sm text-muted-foreground">No connections yet.</p>
      ) : (
        <Group>
          {connections.map((connection) => (
            <ConnectionRow
              canManage={canManage}
              connection={connection}
              key={connection.id}
              onChanged={onChanged}
              sourceName={sources.find((source) => source.id === connection.sourceAppId)?.name}
            />
          ))}
        </Group>
      )}
      {canManage ? <ConnectionForm onChanged={onChanged} sources={sources} /> : null}
    </Section>
  )
}
