'use client'

import { CLAUDE_PLUGIN_INSTALL, PLUGIN_URL } from '@/lib/agents/mcp-clients'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { z } from 'zod'
import { Pill, Section } from '@/components/platform-ui'
import { OutwardIcon } from '@/components/platform-shell/icons'
import { Button } from '@/components/ui/button'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { isPlanRefusal } from '@/lib/api/platform-errors'
import { settingsErrorMessage } from '@/lib/settings/client'
import { useTRPCClient } from '@/lib/trpc/react'
import { connectedSources } from '@/lib/workflows/actions'

/** Where an integration stands in this workspace. */
const statusSchema = z.enum(['connected', 'available', 'not_configured', 'not_available'])

type Status = z.infer<typeof statusSchema>

type Entry = {
  /** What to do to connect it, as a link inside Shots or a public page. */
  action?: { external?: boolean; href: string; label: string }
  authorization: string
  name: string
  purpose: string
  scopes: string
  setup: string
  status: Status
}

const STATUS_LABELS: Record<Status, { label: string; tone: 'gray' | 'green' | 'yellow' | 'blue' }> =
  {
    available: { label: 'Available', tone: 'blue' },
    connected: { label: 'Connected', tone: 'green' },
    not_available: { label: 'Unavailable', tone: 'gray' },
    not_configured: { label: 'Requires setup', tone: 'yellow' },
  }

/**
 * Agents and integrations (RFC 024): every entry the Typefully settings name,
 * with its real state here. An entry with nothing behind it says so and offers
 * no Connect button.
 */
export function IntegrationCatalog({ canManage }: { canManage: boolean }) {
  const trpcClient = useTRPCClient()
  const integrations = useQuery({
    queryFn: () => trpcClient.integration.list.query(),
    queryKey: ['integrations', 'catalog'],
  })
  const agents = useQuery({
    enabled: canManage,
    queryFn: () => trpcClient.apiKey.list.query(),
    queryKey: ['api-keys', 'agents'],
  })
  const github = useQuery({
    enabled: canManage,
    queryFn: () => trpcClient.github.connections.query(),
    queryKey: ['integrations', 'github'],
  })
  const automation = useQuery({
    queryFn: () => trpcClient.releaseAutomation.overview.query(),
    queryKey: ['integrations', 'automation'],
  })
  const hosts = useQuery({
    queryFn: () => trpcClient.frontendDeployments.sources.query(),
    queryKey: ['integrations', 'hosts'],
  })
  const hostStatus = (...providers: string[]): Status =>
    hosts.data?.sources.some((source) => providers.includes(source.provider))
      ? statusSchema.enum.connected
      : statusSchema.enum.available
  const hostEntry = (name: string, ...providers: string[]): Entry => ({
    action: { href: '/workflows/deployments', label: 'Deployments' },
    authorization: 'A read token from your host, kept encrypted.',
    name,
    purpose: `Send an alert or start a workflow when ${name} publishes to production.`,
    scopes: 'Read access to deployments for the project you connect.',
    setup: 'Connect it in Automate, under Deployments.',
    status: hostStatus(...providers),
  })
  const watched = automation.data ? connectedSources(automation.data).length : 0
  const agentClients = (agents.data?.keys ?? [])
    .filter((key) => key.agentClient)
    .map((key) => key.agentClient ?? '')
  const connected = (provider: 'NOTION' | 'SLACK') =>
    (integrations.data?.integrations ?? []).some((item) => item.provider === provider)
  const missing = (provider: 'NOTION' | 'SLACK') =>
    integrations.data?.setup[provider].ready === false
  const agentStatus = (name: string): Status =>
    agentClients.some((client) => client.toLowerCase().includes(name.toLowerCase()))
      ? statusSchema.enum.connected
      : statusSchema.enum.available

  const entries: Entry[] = [
    {
      action: { href: '/workflows/sources', label: 'Repositories' },
      authorization: 'The Shots GitHub App, installed by a workspace owner or admin.',
      name: 'GitHub',
      purpose: watched
        ? `Starts workflows from ${watched} watched ${watched === 1 ? 'repository' : 'repositories'}.`
        : 'Starts workflows when a repository you watch ships something.',
      scopes: 'Read access to the repositories you install the App on.',
      setup: 'Connect GitHub in Automate, under Repositories, then watch a repository.',
      status:
        github.data?.configured === false
          ? statusSchema.enum.not_configured
          : watched || github.data?.connections.some(({ status }) => status === 'ACTIVE')
            ? statusSchema.enum.connected
            : statusSchema.enum.available,
    },
    hostEntry('Vercel', 'vercel'),
    hostEntry('Netlify', 'netlify'),
    hostEntry('Cloudflare', 'cloudflare_pages', 'cloudflare_workers'),
    {
      action: { href: '/settings/ai-agents', label: 'Set up' },
      authorization:
        'OAuth consent by a workspace owner or admin; it mints a scoped workspace key.',
      name: 'Claude',
      purpose:
        'Write, schedule and publish posts, and read releases and campaigns, from Claude.ai, Claude Desktop and Claude Code.',
      scopes: 'Reading, drafting and uploads by default. Posting needs post:publish, which you tick.',
      setup: 'Add the Shots MCP server as a connector in Claude, then approve it here.',
      status: agentStatus('claude'),
    },
    {
      action: { href: '/settings/ai-agents', label: 'Set up' },
      authorization: 'OAuth consent by a workspace owner or admin.',
      name: 'ChatGPT',
      purpose: 'The same Shots tools from ChatGPT connectors.',
      scopes: 'The scopes you approve at consent.',
      setup: 'Add the Shots MCP server as a ChatGPT connector, then approve it here.',
      status: agentStatus('chatgpt'),
    },
    {
      action: { href: '/settings/ai-agents', label: 'Show the server URL' },
      authorization: 'OAuth, or a workspace API key in the X-API-Key header.',
      name: 'MCP',
      purpose:
        'Any agent that speaks the Model Context Protocol: Codex, OpenCode, Cursor, VS Code, Windsurf, Gemini CLI and more.',
      scopes: 'Each tool needs one API key scope; the key decides what the agent can do.',
      setup: 'Copy the MCP server URL into your client.',
      status: agentClients.length > 0 ? 'connected' : 'available',
    },
    {
      action: {
        external: true,
        href: PLUGIN_URL,
        label: 'View the plugin',
      },
      authorization: 'The MCP connection above; the skill adds no access of its own.',
      name: 'Agent Skills',
      purpose:
        'A plugin for Claude Code and Codex, and a skill for OpenCode, that write, schedule and publish posts over the Shots MCP server.',
      scopes: 'Those of the MCP connection.',
      setup: `In Claude Code: ${CLAUDE_PLUGIN_INSTALL}. Codex and OpenCode: Settings → AI agents.`,
      status: 'available',
    },
    {
      authorization: 'None today.',
      name: 'Notion Agents',
      purpose:
        "There is no Shots integration for Notion's agents. The Notion integration below delivers published designs to a Notion page.",
      scopes: '—',
      setup: 'Connect Notion below to deliver designs.',
      status: 'not_available',
    },
    {
      action: { href: '/settings/notifications', label: 'Notification settings' },
      authorization: 'A Slack app install by a workspace owner or admin.',
      name: 'Slack',
      purpose: 'Activity notifications in a channel, and published designs delivered to Slack.',
      scopes:
        'chat:write, channels:read, groups:read, files:write, channels:join. Direct messages are not supported: the app does not ask for im:write.',
      setup: missing('SLACK')
        ? 'The server needs its Slack app credentials first.'
        : 'Connect from Notifications or below.',
      status: connected('SLACK') ? 'connected' : missing('SLACK') ? 'not_configured' : 'available',
    },
    {
      action: { href: '/settings/developers', label: 'Create a webhook' },
      authorization: 'A webhook URL from Zapier, and an API key for actions.',
      name: 'Zapier',
      purpose:
        'There is no Shots app in Zapier. Zapier can still receive Shots events and call the Shots API.',
      scopes: 'Webhooks deliver draft events; an API key with the scopes you pick lets a Zap act.',
      setup:
        "Point a Webhooks by Zapier Catch Hook at a Shots webhook, and use the API with Zapier's Webhooks action.",
      status: 'not_available',
    },
    {
      authorization: 'None today.',
      name: 'Raycast',
      purpose: 'There is no Shots extension for Raycast.',
      scopes: '—',
      setup: 'Not available.',
      status: 'not_available',
    },
  ]

  return (
    <Section
      description="What each integration does, what it needs, and whether it works here today."
      title="Agents and integrations"
    >
      {/* A plan refusal is explained once, by the provider sections below. */}
      {integrations.isError && !isPlanRefusal(integrations.error) ? (
        <p className="text-sm text-red-700 dark:text-red-300" role="alert">
          {settingsErrorMessage(integrations.error)}
        </p>
      ) : null}
      {/* A list, not headings: the provider sections below already head "Slack" and "Notion". */}
      <ul
        aria-label="Agents and integrations"
        className="flex w-full flex-col divide-y divide-foreground/[0.07] overflow-hidden rounded-2xl bg-foreground/[0.015] ring-1 ring-foreground/[0.08]"
      >
        {entries.map((entry) => {
          // Without a plan nothing here works yet, whatever its own state.
          const status =
            STATUS_LABELS[
              isPlanRefusal(integrations.error) ? statusSchema.enum.not_available : entry.status
            ]
          return (
            <li
              className="flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between"
              key={entry.name}
            >
              <div className="min-w-0 md:max-w-[60%]">
                <p className="flex items-center gap-2 text-ui-lg font-medium text-foreground">
                  {entry.name}
                  <Pill tone={status.tone}>{status.label}</Pill>
                </p>
                <div className="mt-0.5 grid gap-1 text-xs text-muted-foreground">
                  <span>{entry.purpose}</span>
                  <Disclosure>
                    <DisclosureTrigger>Access and setup details</DisclosureTrigger>
                    <DisclosureContent>
                      <p>
                        <strong className="font-medium text-foreground/80">Access:</strong>{' '}
                        {entry.authorization}
                      </p>
                      <span>
                        <strong className="font-medium text-foreground/80">Scopes:</strong>{' '}
                        {entry.scopes}
                      </span>
                      <span>
                        <strong className="font-medium text-foreground/80">Setup:</strong>{' '}
                        {entry.setup}
                      </span>
                    </DisclosureContent>
                  </Disclosure>
                </div>
              </div>
              {entry.status === 'not_configured' ? (
                <p className="text-sm text-muted-foreground">
                  Contact your administrator to enable this integration.
                </p>
              ) : entry.action ? (
                <div className="flex min-w-0 items-center gap-2 md:justify-end">
                  <Button asChild size="sm" variant="outline">
                    {entry.action.external ? (
                      <a href={entry.action.href} rel="noreferrer" target="_blank">
                        {entry.action.label}
                        <OutwardIcon aria-hidden="true" size={14} />
                      </a>
                    ) : (
                      <Link href={entry.action.href}>{entry.action.label}</Link>
                    )}
                  </Button>
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </Section>
  )
}
