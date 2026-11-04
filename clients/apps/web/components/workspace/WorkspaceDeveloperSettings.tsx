'use client'

import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { z } from 'zod'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { KeyExpiry } from '@/components/settings/KeyExpiry'
import { Label } from '@/components/ui/label'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { apiKeyScopeDescriptions, apiKeyScopes, type ApiKeyScope } from '@/lib/auth/api-key-scopes'
import { useTRPCClient } from '@/lib/trpc/react'
import { GitHubConnections } from './GitHubConnections'
import { getErrorMessage } from './settings-client'
import { ConfirmDialog } from '@/components/settings/ConfirmDialog'

const sourceProviderSchema = z.enum(['generic', 'github', 'gitlab'])

const sourceSchema = z.object({
  allowedHost: z.string().url(),
  branch: z.string().trim().max(255),
  name: z.string().trim().min(2).max(100),
  provider: sourceProviderSchema,
})

/** A just-created source: where its provider sends deliveries, shown once. */
type NewSource = {
  provider: z.infer<typeof sourceProviderSchema>
  webhook: { secret: string | null; url: string }
}

type WorkspaceDeveloperSettingsProps = { canManage: boolean }
type ApiKey = {
  createdAt: Date | string
  enabled: boolean | null
  expiresAt: Date | string | null
  id: string
  lastRequest: Date | string | null
  name: string | null
  prefix: string | null
  start: string | null
}

/** A key's state: active, disabled, or past its expiry. */
function keyStatus(key: ApiKey): { label: string; tone: 'gray' | 'green' | 'yellow' } {
  if (!key.enabled) return { label: 'disabled', tone: 'gray' }
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now())
    return { label: 'expired', tone: 'yellow' }
  return { label: 'active', tone: 'green' }
}

function readableDate(value: Date | string | null): string {
  return value ? new Date(value).toLocaleDateString() : ''
}

export function WorkspaceDeveloperSettings({ canManage }: WorkspaceDeveloperSettingsProps) {
  const trpcClient = useTRPCClient()
  const [error, setError] = useState<string | null>(null)
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [newKey, setNewKey] = useState<string | null>(null)
  const [newSource, setNewSource] = useState<NewSource | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)

  const loadKeys = useCallback(async (): Promise<void> => {
    try {
      const result = await trpcClient.apiKey.list.query()
      setKeys(result.keys)
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    }
  }, [trpcClient])

  useEffect(() => {
    void loadKeys()
  }, [loadKeys])

  async function createKey(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError(null)
    const form = event.currentTarget
    const data = new FormData(form)
    const scopes = data.getAll('scopes').map(String) as ApiKeyScope[]
    setPendingId('create-key')
    try {
      const expiresInDays = data.get('expiresInDays')
      const result = await trpcClient.apiKey.create.mutate({
        expiresInDays:
          expiresInDays && expiresInDays !== 'never' ? Number(expiresInDays) : undefined,
        name: String(data.get('name') ?? ''),
        scopes,
      })
      setNewKey(result.apiKey.key)
      form.reset()
      await loadKeys()
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    } finally {
      setPendingId(null)
    }
  }

  async function revokeKey(keyId: string): Promise<void> {
    setError(null)
    setPendingId(keyId)
    try {
      await trpcClient.apiKey.revoke.mutate({ keyId })
      await loadKeys()
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    } finally {
      setPendingId(null)
    }
  }

  async function createSource(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError(null)
    const form = event.currentTarget
    const input = sourceSchema.safeParse(Object.fromEntries(new FormData(form)))
    if (!input.success) {
      setError(input.error.issues[0]?.message ?? 'Check the source values.')
      return
    }
    setPendingId('create-source')
    try {
      const result = await trpcClient.sourceApp.create.mutate({
        allowedHosts: [input.data.allowedHost],
        ...(input.data.branch ? { branch: input.data.branch } : {}),
        name: input.data.name,
        provider: input.data.provider,
      })
      setNewSource({ provider: input.data.provider, webhook: result.webhook })
      form.reset()
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className="flex flex-col gap-10">
      {newKey ? <NewKeyNotice apiKey={newKey} onDismiss={() => setNewKey(null)} /> : null}
      <Section
        description="Keys are shown once. Revoke a key when it is no longer needed."
        title="Organization API keys"
      >
        <Group>
          <ApiKeyList
            canManage={canManage}
            isRevoking={pendingId}
            keys={keys}
            onRevoke={revokeKey}
          />
          {canManage ? (
            <Row>
              <ApiKeyForm isSubmitting={pendingId === 'create-key'} onSubmit={createKey} />
            </Row>
          ) : null}
        </Group>
      </Section>
      {canManage ? <GitHubConnections /> : null}
      {canManage ? (
        <Section
          description="Allow a Git provider or release tool to send content to this workspace."
          title="Inbound release source"
        >
          {newSource ? (
            <NewSourceNotice onDismiss={() => setNewSource(null)} source={newSource} />
          ) : null}
          <Group>
            <Row>
              <SourceForm isSubmitting={pendingId === 'create-source'} onSubmit={createSource} />
            </Row>
          </Group>
        </Section>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}

const fieldLabel = 'text-xs font-medium text-foreground/65'

function NewKeyNotice({ apiKey, onDismiss }: { apiKey: string; onDismiss: () => void }) {
  async function copyKey(): Promise<void> {
    await navigator.clipboard.writeText(apiKey)
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-emerald-500/5 p-5 ring-1 ring-emerald-500/20">
      <p className="text-sm font-medium text-foreground">
        Copy this API key now. It cannot be shown again.
      </p>
      <code className="overflow-x-auto rounded-lg bg-black/30 p-3 font-mono text-xs text-foreground/80 ring-1 ring-foreground/[0.08]">
        {apiKey}
      </code>
      <div className="flex gap-2">
        <Button className="rounded-lg" onClick={() => void copyKey()} size="sm" type="button">
          Copy key
        </Button>
        <Button onClick={onDismiss} size="sm" type="button" variant="ghost">
          Done
        </Button>
      </div>
    </div>
  )
}

function SetupValue({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className={fieldLabel} htmlFor={id}>
        {label}
      </Label>
      <div className="flex gap-2">
        <Input className="h-9 rounded-lg font-mono text-xs" id={id} readOnly value={value} />
        <Button
          aria-label={`Copy ${label.toLowerCase()}`}
          className="rounded-lg"
          onClick={() => void navigator.clipboard.writeText(value)}
          size="sm"
          type="button"
        >
          Copy
        </Button>
      </div>
    </div>
  )
}

function NewSourceNotice({ onDismiss, source }: { onDismiss: () => void; source: NewSource }) {
  const { secret, url } = source.webhook
  return (
    <div className="mb-4 flex flex-col gap-3 rounded-2xl bg-emerald-500/5 p-5 ring-1 ring-emerald-500/20">
      <p className="text-sm font-medium text-foreground">
        Add this webhook to your repository.{secret ? ' The secret cannot be shown again.' : ''}
      </p>
      <SetupValue id="source-webhook-url" label="Payload URL" value={url} />
      {secret ? (
        <SetupValue id="source-webhook-secret" label="Secret" value={secret} />
      ) : (
        <p className="text-sm text-foreground/65">
          {source.provider === 'gitlab'
            ? 'GitLab generates its own signing token. Ask an operator to configure it for this source.'
            : 'Webhook signing is unavailable. Contact your administrator to enable it.'}
        </p>
      )}
      {!secret && source.provider !== 'gitlab' ? (
        <Disclosure className="text-xs text-muted-foreground">
          <DisclosureTrigger>Administrator setup details</DisclosureTrigger>
          <DisclosureContent>
            <p>Configure SOURCE_WEBHOOK_SIGNING_KEY on the server.</p>
          </DisclosureContent>
        </Disclosure>
      ) : null}
      {source.provider === 'github' && secret ? (
        <p className="text-sm text-foreground/65">
          In GitHub, open the repository’s Settings, then Webhooks, then Add webhook. Paste the
          payload URL and secret, choose “Let me select individual events”, and select Pull requests
          and Releases. Merged PRs are held as changes for a published release. To define PR or
          deployment release triggers, connect the GitHub App in Workflows.
        </p>
      ) : null}
      <div className="flex">
        <Button onClick={onDismiss} size="sm" type="button" variant="ghost">
          Done
        </Button>
      </div>
    </div>
  )
}

function ApiKeyForm({
  isSubmitting,
  onSubmit,
}: {
  isSubmitting: boolean
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>
}) {
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['artifact:read'])
  return (
    <form
      className="flex flex-col gap-4"
      onReset={() => setScopes(['artifact:read'])}
      onSubmit={onSubmit}
    >
      <h3 className="text-sm font-medium text-foreground">Create a key</h3>
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
        <div className="flex flex-col gap-1.5">
          <Label className={fieldLabel} htmlFor="api-key-name">
            Key name
          </Label>
          <Input
            className="h-10 rounded-lg"
            id="api-key-name"
            name="name"
            placeholder="Production deploys"
            required
          />
        </div>
        <KeyExpiry id="api-key-expires" />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className={`mb-2 ${fieldLabel}`}>Scopes</legend>
        <div className="mb-2 flex flex-wrap gap-2">
          <Button
            onClick={() => setScopes(['artifact:read'])}
            size="sm"
            type="button"
            variant="outline"
          >
            Read only
          </Button>
          <Button
            onClick={() => setScopes(['artifact:read', 'draft:write'])}
            size="sm"
            type="button"
            variant="outline"
          >
            Draft creation
          </Button>
          <Button
            onClick={() => setScopes(['artifact:read', 'post:schedule'])}
            size="sm"
            type="button"
            variant="outline"
          >
            Publishing
          </Button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {apiKeyScopes.map((scope) => (
            <div className="flex min-w-0 items-start gap-2" key={scope}>
              <Checkbox
                checked={scopes.includes(scope)}
                onCheckedChange={(checked) =>
                  setScopes((current) =>
                    checked === true
                      ? [...current, scope]
                      : current.filter((item) => item !== scope)
                  )
                }
                id={`scope-${scope}`}
                name="scopes"
                value={scope}
              />
              <Label className="block min-w-0 text-xs text-foreground/80" htmlFor={`scope-${scope}`}>
                {apiKeyScopeDescriptions[scope]}
                <span className="mt-1 block break-all font-mono text-muted-foreground">{scope}</span>
              </Label>
            </div>
          ))}
        </div>
      </fieldset>
      <div className="flex justify-end">
        <Button className="rounded-lg" disabled={isSubmitting || scopes.length === 0} type="submit">
          {isSubmitting ? 'Creating…' : 'Create API key'}
        </Button>
      </div>
    </form>
  )
}

function ApiKeyList({
  canManage,
  isRevoking,
  keys,
  onRevoke,
}: {
  canManage: boolean
  isRevoking: string | null
  keys: ApiKey[]
  onRevoke: (keyId: string) => Promise<void>
}) {
  if (keys.length === 0)
    return (
      <Row>
        <p className="text-sm text-muted-foreground">No API keys have been created.</p>
      </Row>
    )
  return keys.map((key) => {
    const status = keyStatus(key)
    return (
      <div className="flex flex-wrap items-center gap-4 px-5 py-4" key={key.id}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-foreground">{key.name ?? 'Untitled key'}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {key.start ?? key.prefix ?? 'Hidden key'}
          </p>
          <p className="text-xs text-muted-foreground">
            Created {readableDate(key.createdAt)}
            {key.expiresAt ? ` · Expires ${readableDate(key.expiresAt)}` : ' · Never expires'}
            {key.lastRequest
              ? ` · Last used ${new Date(key.lastRequest).toLocaleString()}`
              : ' · Not used yet'}
          </p>
        </div>
        <Pill tone={status.tone}>{status.label}</Pill>
        {canManage ? (
          <ConfirmDialog
            confirmLabel="Revoke key"
            description="Anything using this key stops working at once. This cannot be undone; create a new key to replace it."
            destructive
            disabled={isRevoking === key.id}
            onConfirm={async () => {
              await onRevoke(key.id)
              return null
            }}
            title={`Revoke ${key.name ?? 'this key'}?`}
            triggerLabel="Revoke"
          />
        ) : null}
      </div>
    )
  })
}

function SourceForm({
  isSubmitting,
  onSubmit,
}: {
  isSubmitting: boolean
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>
}) {
  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
        <div className="flex flex-col gap-1.5">
          <Label className={fieldLabel} htmlFor="source-name">
            Source name
          </Label>
          <Input
            className="h-10 rounded-lg"
            id="source-name"
            name="name"
            placeholder="GitHub production"
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className={fieldLabel} htmlFor="source-provider">
            Provider
          </Label>
          <Select defaultValue="github" name="provider">
            <SelectTrigger className="h-10 w-full rounded-lg" id="source-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="github">GitHub</SelectItem>
              <SelectItem value="gitlab">GitLab</SelectItem>
              <SelectItem value="generic">Generic webhook</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label className={fieldLabel} htmlFor="source-branch">
          Branch
        </Label>
        <Input
          className="h-10 rounded-lg"
          id="source-branch"
          name="branch"
          placeholder="Leave empty to follow the default branch"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label className={fieldLabel} htmlFor="source-allowed-host">
          Allowed host
        </Label>
        <Input
          className="h-10 rounded-lg"
          id="source-allowed-host"
          name="allowedHost"
          placeholder="https://api.github.com"
          required
          type="url"
        />
      </div>
      <div className="flex justify-end">
        <Button className="rounded-lg" disabled={isSubmitting} type="submit">
          {isSubmitting ? 'Adding…' : 'Add source'}
        </Button>
      </div>
    </form>
  )
}
