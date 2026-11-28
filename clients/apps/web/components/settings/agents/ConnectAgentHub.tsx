'use client'

import { ArrowUpRight, Copy } from '@phosphor-icons/react'
import Link from 'next/link'
import { useState } from 'react'
import { toast } from 'sonner'
import { Group, Pill, Row, Section } from '@/components/platform-ui'
import { Button } from '@/components/ui/button'
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { agentGuideMarkdownPath, buildAgentBriefMarkdown } from '@/lib/agents/agent-briefs'
import {
  API_KEY_PLACEHOLDER,
  DEFAULT_AGENT_PROMPT,
  MCP_CLIENTS,
  MCP_TOOLS,
} from '@/lib/agents/mcp-clients'
import { AgentBrandIcon } from './AgentIcons'
import { copyToClipboard } from './ScopeBadge'

const MCP_TOOLS_BY_SCOPE = MCP_TOOLS.reduce<
  Record<string, { name: string; summary: string }[]>
>((groups, tool) => {
  const bucket = groups[tool.scope] ?? []
  bucket.push({ name: tool.name, summary: tool.summary })
  groups[tool.scope] = bucket
  return groups
}, {})

/**
 * Interactive "Connect an AI agent" hub: 13-client tabbed onboarding,
 * one-click "Give this guide to <Agent>" Markdown handoff, OAuth-first setup
 * steps, collapsible manual/CLI/API-key fallbacks, and live tool explorer.
 */
export function ConnectAgentHub({
  apiKey,
  canCreateKey,
  mcpUrl,
  onOpenCreateKey,
  origin,
}: {
  apiKey: string | null
  canCreateKey: boolean
  mcpUrl: string
  onOpenCreateKey: () => void
  origin: string
}) {
  const [clientId, setClientId] = useState(MCP_CLIENTS[0]!.id)
  const client = MCP_CLIENTS.find((item) => item.id === clientId) ?? MCP_CLIENTS[0]!
  const resolvedKey = apiKey ?? API_KEY_PLACEHOLDER
  const snippet = client.snippet(mcpUrl, resolvedKey, origin)
  const primaryAction = client.primaryAction?.(origin) ?? null
  const guideLabel = client.id === 'any-mcp' ? 'your agent' : client.name

  function handleCopyGuide(): void {
    const markdown = buildAgentBriefMarkdown(client.id, { mcpUrl, origin })
    if (!markdown) {
      toast.error('Guide unavailable.')
      return
    }
    copyToClipboard(markdown, `${client.name} guide`)
  }

  return (
    <Section
      description="Point Claude, ChatGPT, or your own agent at Shots to draft releases, upload visuals, and schedule or publish posts. MCP is included with every paid plan and signs in with your workspace over OAuth, so you don't need an API key for this (keys are for the REST API and CLI)."
      title="Connect an AI agent"
    >
      <Group>
        <Tabs
          className="flex flex-col gap-6 p-5"
          onValueChange={setClientId}
          value={client.id}
        >
          {/* Horizontal agent selector pills */}
          <TabsList
            aria-label="Choose an AI agent"
            className="flex h-auto w-full flex-wrap items-center justify-start gap-1.5 bg-transparent p-0"
          >
            {MCP_CLIENTS.map((item) => (
              <TabsTrigger
                className="h-8 flex-none gap-1.5 rounded-lg border-transparent px-2.5 text-xs font-medium text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground data-[state=active]:border-transparent data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-xs"
                key={item.id}
                value={item.id}
              >
                <AgentBrandIcon icon={item.icon} size={14} />
                <span>{item.tabLabel}</span>
              </TabsTrigger>
            ))}
          </TabsList>

          {/* Active client panel: Markdown handoff + step-by-step setup */}
          <TabsContent className="flex flex-col gap-6" value={client.id}>
            {/* "Give this guide to <Agent>" callout box */}
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-foreground/[0.02] p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium text-foreground">
                  Give this guide to {guideLabel}
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {client.briefDescription}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-3">
                <Button onClick={handleCopyGuide} size="sm" type="button">
                  Copy for agent
                </Button>
                {client.showMarkdownLink ? (
                  <a
                    className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    href={agentGuideMarkdownPath(client.id)}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    or open as markdown
                  </a>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <AgentBrandIcon icon={client.icon} size={16} />
                <h3 className="text-sm font-semibold text-foreground">{client.headline}</h3>
                <Pill tone={client.badge.tone === 'emerald' ? 'green' : 'gray'}>
                  {client.badge.label}
                </Pill>
              </div>

              <ol className="space-y-2 text-sm text-foreground/80">
                {client.steps.map((step, index) => (
                  <li className="flex items-start gap-2.5" key={step}>
                    <span
                      aria-hidden="true"
                      className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300"
                    >
                      {index + 1}
                    </span>
                    <span className="leading-snug">{step}</span>
                  </li>
                ))}
              </ol>

              {client.showPrimarySnippet !== false ? (
                <div className="relative">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">{client.location}</span>
                    <Button
                      aria-label={`Copy ${client.name} configuration`}
                      className="h-7 gap-1 px-2 text-xs"
                      onClick={() => copyToClipboard(snippet, `${client.name} configuration`)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      <Copy aria-hidden="true" className="size-3.5" />
                      Copy
                    </Button>
                  </div>
                  <pre className="overflow-x-auto rounded-xl border border-border bg-foreground/[0.04] p-3.5 font-mono text-xs leading-relaxed text-foreground">
                    <code>{snippet}</code>
                  </pre>
                </div>
              ) : null}

              {primaryAction ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button asChild size="sm">
                    {primaryAction.external ? (
                      <a href={primaryAction.href} rel="noopener noreferrer" target="_blank">
                        {primaryAction.label}
                      </a>
                    ) : (
                      <Link href={primaryAction.href}>{primaryAction.label}</Link>
                    )}
                  </Button>
                </div>
              ) : null}

              {client.note ? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {client.note}{' '}
                  {client.auth === 'api-key' && canCreateKey ? (
                    <Button
                      className="h-auto p-0 text-xs underline underline-offset-4"
                      onClick={onOpenCreateKey}
                      type="button"
                      variant="link"
                    >
                      Create API key
                    </Button>
                  ) : null}
                </p>
              ) : null}

              {client.fallback ? (
                <Disclosure
                  className="rounded-xl border border-border/70 bg-foreground/[0.015] px-4 py-3"
                  key={client.id}
                >
                  <DisclosureTrigger className="text-xs font-medium text-foreground/85">
                    {client.fallback.triggerLabel}
                  </DisclosureTrigger>
                  <DisclosureContent className="mt-3 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">
                        {client.fallback.location}
                      </span>
                      <Button
                        aria-label={`Copy ${client.name} fallback configuration`}
                        className="h-7 gap-1 px-2 text-xs"
                        onClick={() =>
                          copyToClipboard(
                            client.fallback!.snippet(mcpUrl, resolvedKey, origin),
                            `${client.name} fallback configuration`
                          )
                        }
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <Copy aria-hidden="true" className="size-3.5" />
                        Copy
                      </Button>
                    </div>
                    <pre className="overflow-x-auto rounded-lg border border-border bg-foreground/[0.04] p-3 font-mono text-xs leading-relaxed text-foreground">
                      <code>{client.fallback.snippet(mcpUrl, resolvedKey, origin)}</code>
                    </pre>
                    <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                      {client.fallback.steps.map((step) => (
                        <li key={step}>{step}</li>
                      ))}
                    </ul>
                  </DisclosureContent>
                </Disclosure>
              ) : null}

              <div className="flex flex-col gap-2 border-t border-border/60 pt-4 text-xs text-muted-foreground">
                <p>
                  Then just ask it to post something. Try:{' '}
                  <span className="font-medium text-foreground/85">“{DEFAULT_AGENT_PROMPT}”</span>.
                </p>
              <div className="flex flex-wrap items-center gap-4">
                <Link
                  className="inline-flex items-center gap-1 font-medium text-emerald-700 hover:underline dark:text-emerald-400"
                  href="/docs/agents"
                >
                  Full setup guide and available tools
                  <ArrowUpRight aria-hidden="true" className="size-3.5" />
                </Link>
              </div>
            </div>
            </div>
          </TabsContent>
        </Tabs>

        {/* Collapsible live MCP tool & scope explorer */}
        <Row>
          <Disclosure>
            <DisclosureTrigger
              className="py-0.5 text-sm font-medium text-foreground"
              summary={`${MCP_TOOLS.length} tools across ${Object.keys(MCP_TOOLS_BY_SCOPE).length} scopes`}
            >
              Inspect available MCP tools
            </DisclosureTrigger>
            <DisclosureContent className="pt-4">
              <div className="flex flex-col gap-4">
                {Object.entries(MCP_TOOLS_BY_SCOPE).map(([scope, tools]) => (
                  <div className="flex flex-col gap-1.5" key={scope}>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-medium text-foreground">{scope}</span>
                      <span className="text-xs text-muted-foreground">({tools.length})</span>
                    </div>
                    <ul className="grid gap-1 sm:grid-cols-2">
                      {tools.map((tool) => (
                        <li
                          className="rounded-lg border border-border/70 bg-foreground/[0.02] px-2.5 py-1.5"
                          key={tool.name}
                        >
                          <p className="font-mono text-xs text-foreground">{tool.name}</p>
                          <p className="text-xs text-muted-foreground">{tool.summary}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </DisclosureContent>
          </Disclosure>
        </Row>
      </Group>
    </Section>
  )
}
