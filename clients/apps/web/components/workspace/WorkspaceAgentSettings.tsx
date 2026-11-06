'use client'

import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { KeyExpiry } from '@/components/settings/KeyExpiry'
import { Label } from '@/components/ui/label'
import { API_KEY_PLACEHOLDER, MCP_CLIENTS, type McpClientGuide } from '@/lib/agents/mcp-clients'
import {
  apiKeyScopeDescriptions,
  apiKeyScopes,
  defaultAgentScopes,
  type ApiKeyScope,
} from '@/lib/auth/api-key-scopes'
import { useTRPCClient } from '@/lib/trpc/react'
import { getErrorMessage } from './settings-client'

type AgentKey = {
  agentClient: string | null
  createdAt: Date | string
  enabled: boolean | null
  id: string
  name: string | null
  start: string | null
}

const fieldLabel = 'text-xs font-medium text-foreground/65'

/**
 * Settings → AI agents (RFC 026): the workspace's MCP server URL, a scoped
 * key for agents that take one, each client's configuration, and the agents
 * connected through OAuth. Keys come from the Go backend through the API key
 * router; nothing here reaches the database.
 */
export function WorkspaceAgentSettings({
  canManage,
  mcpUrl,
}: {
  canManage: boolean
  mcpUrl: string
}) {
  const trpcClient = useTRPCClient()
  const [error, setError] = useState<string | null>(null)
  const [keys, setKeys] = useState<AgentKey[]>([])
  const [newKey, setNewKey] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [clientId, setClientId] = useState(MCP_CLIENTS[0]!.id)

  const loadKeys = useCallback(async (): Promise<void> => {
    try {
      setKeys((await trpcClient.apiKey.list.query()).keys)
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    }
  }, [trpcClient])

  useEffect(() => {
    if (canManage) void loadKeys()
  }, [canManage, loadKeys])

  async function createKey(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setError(null)
    const form = event.currentTarget
    const data = new FormData(form)
    setPending('create')
    try {
      const expiresInDays = data.get('expiresInDays')
      const result = await trpcClient.apiKey.create.mutate({
        expiresInDays:
          expiresInDays && expiresInDays !== 'never' ? Number(expiresInDays) : undefined,
        name: String(data.get('name') ?? ''),
        scopes: data.getAll('scopes').map(String) as ApiKeyScope[],
      })
      setNewKey(result.apiKey.key)
      await loadKeys()
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    } finally {
      setPending(null)
    }
  }

  async function revoke(keyId: string): Promise<void> {
    setError(null)
    setPending(keyId)
    try {
      await trpcClient.apiKey.revoke.mutate({ keyId })
      await loadKeys()
    } catch (requestError) {
      setError(getErrorMessage(requestError))
    } finally {
      setPending(null)
    }
  }

  const client = MCP_CLIENTS.find((item) => item.id === clientId) ?? MCP_CLIENTS[0]!
  const connected = keys.filter((key) => key.agentClient)

  return (
    <div className="flex flex-col gap-10">
      <Section
        description="Connect your AI client with this URL. You choose what it can do; your plan and usage limits still apply."
        title="MCP server"
      >
        <Group>
          <Row>
            <CopyValue id="mcp-url" label="Server URL" value={mcpUrl} />
            <p className="text-xs text-muted-foreground">
              Agents can read releases, campaigns, the review queue, and the schedule, create
              drafts, upload assets, capture screenshots, and submit drafts for review. With
              post:publish they also post to your shared accounts, with no review unless the
              workspace requires approval. Only a person approves.{' '}
              <a className="underline underline-offset-4" href="/docs/agents">
                Setup guides
              </a>
            </p>
          </Row>
        </Group>
      </Section>

      {canManage ? (
        <Section
          description="Claude.ai, Claude Desktop, and ChatGPT connect through OAuth and ask you to approve them. Other clients can use OAuth too, or a key: create one here and it fills in the configuration below."
          title="Agent key"
        >
          {newKey ? (
            <div className="flex flex-col gap-3 rounded-2xl bg-emerald-500/5 p-5 ring-1 ring-emerald-500/20">
              <p className="text-ui-lg font-medium text-foreground">
                Copy this key now. It cannot be shown again; the configurations below include it
                until you leave this page.
              </p>
              <CopyValue id="agent-key" label="API key" value={newKey} />
            </div>
          ) : null}
          <Group>
            <Row>
              <AgentKeyForm isSubmitting={pending === 'create'} onSubmit={createKey} />
            </Row>
          </Group>
        </Section>
      ) : (
        <Alert>
          <AlertDescription>
            Ask a workspace owner or admin to create an agent key or approve an agent.
          </AlertDescription>
        </Alert>
      )}

      <Section description="Pick your client and copy its configuration." title="Connect a client">
        <div aria-label="Client" className="flex flex-wrap gap-2" role="tablist">
          {MCP_CLIENTS.map((item) => (
            <Button
              aria-selected={item.id === client.id}
              className="rounded-lg"
              key={item.id}
              onClick={() => setClientId(item.id)}
              role="tab"
              size="sm"
              type="button"
              variant={item.id === client.id ? 'default' : 'ghost'}
            >
              {item.name}
            </Button>
          ))}
        </div>
        <ClientGuide apiKey={newKey ?? API_KEY_PLACEHOLDER} client={client} mcpUrl={mcpUrl} />
      </Section>

      {canManage ? (
        <Section
          description="Agents you approved through OAuth. Revoking one ends its connection at its next call. Every key is also listed under Developer API."
          title="Connected agents"
        >
          <Group>
            {connected.length === 0 ? (
              <Row>
                <p className="text-sm text-muted-foreground">
                  No agent is connected through OAuth.
                </p>
              </Row>
            ) : (
              connected.map((key) => (
                <div className="flex items-center gap-4 px-5 py-4" key={key.id}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{key.agentClient}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      Approved {new Date(key.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Pill tone={key.enabled ? 'green' : 'gray'}>
                    {key.enabled ? 'connected' : 'disabled'}
                  </Pill>
                  <Button
                    className="text-red-700 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300"
                    disabled={pending === key.id}
                    onClick={() => void revoke(key.id)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Revoke
                  </Button>
                </div>
              ))
            )}
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

function CopyValue({ id, label, value }: { id: string; label: string; value: string }) {
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

function AgentKeyForm({
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
          <Label className={fieldLabel} htmlFor="agent-key-name">
            Key name
          </Label>
          <Input
            className="h-10 rounded-lg"
            defaultValue="Coding agent"
            id="agent-key-name"
            name="name"
            required
          />
        </div>
        <KeyExpiry id="agent-key-expires" />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className={`mb-2 ${fieldLabel}`}>What the agent may do</legend>
        {apiKeyScopes.map((scope) => (
          <div className="flex items-start gap-2" key={scope}>
            <Checkbox
              className="mt-0.5"
              defaultChecked={defaultAgentScopes.includes(scope)}
              id={`agent-scope-${scope}`}
              name="scopes"
              value={scope}
            />
            <Label className="flex flex-col items-start gap-0.5" htmlFor={`agent-scope-${scope}`}>
              <span className="font-mono text-xs text-foreground/80">{scope}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {apiKeyScopeDescriptions[scope]}
              </span>
            </Label>
          </div>
        ))}
      </fieldset>
      <div className="flex justify-end">
        <Button className="rounded-lg" disabled={isSubmitting} type="submit">
          {isSubmitting ? 'Creating…' : 'Create agent key'}
        </Button>
      </div>
    </form>
  )
}

function ClientGuide({
  apiKey,
  client,
  mcpUrl,
}: {
  apiKey: string
  client: McpClientGuide
  mcpUrl: string
}) {
  const snippet = client.snippet(mcpUrl, apiKey)
  return (
    <Group>
      <Row>
        <div className="flex flex-col gap-1">
          <p className="text-ui-lg font-medium text-foreground">{client.name}</p>
          <p className="text-xs text-muted-foreground">{client.location}</p>
        </div>
        <pre className="overflow-x-auto rounded-lg bg-black/30 p-3 font-mono text-xs leading-relaxed text-foreground ring-1 ring-foreground/[0.08]">
          <code>{snippet}</code>
        </pre>
        <div className="flex">
          <Button
            className="rounded-lg"
            onClick={() => void navigator.clipboard.writeText(snippet)}
            size="sm"
            type="button"
          >
            Copy{' '}
            {client.language === 'bash'
              ? 'command'
              : client.language === 'text'
                ? 'URL'
                : 'configuration'}
          </Button>
        </div>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground/65">
          {client.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        {apiKey === API_KEY_PLACEHOLDER && client.auth !== 'oauth' ? (
          <p className="text-xs text-muted-foreground">
            Set SHOTS_API_KEY to an agent key, or create one above to fill it in.
          </p>
        ) : null}
      </Row>
    </Group>
  )
}
