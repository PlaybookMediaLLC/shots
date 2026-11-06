import { Metadata } from 'next'
import Link from 'next/link'
import { Footer } from '@/components/landing/Footer'
import { Navigation } from '@/components/landing/Navigation'
import { API_KEY_PLACEHOLDER, MCP_CLIENTS, MCP_TOOLS, MCP_URL } from '@/lib/agents/mcp-clients'
import { apiKeyScopeDescriptions, apiKeyScopes } from '@/lib/auth/api-key-scopes'
import { INTER, codeBlockClassName, linkClassName } from '@/lib/seo/docs-shared'
import { OG_DEFAULTS } from '@/lib/seo/metadata'
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table'

export const metadata: Metadata = {
  alternates: { canonical: '/docs/agents' },
  description:
    'Connect Claude Code, Claude.ai, ChatGPT, Cursor, VS Code, Windsurf, Gemini CLI, Codex CLI, and OpenCode to a Shots workspace through the Shots MCP server.',
  openGraph: {
    ...OG_DEFAULTS,
    description: 'Set up the Shots MCP server in your AI agent with a workspace API key or OAuth.',
    title: 'Connect AI agents to Shots',
    url: '/docs/agents',
  },
  title: 'Connect AI agents to Shots',
}

const heading = 'mb-3 text-xl font-semibold tracking-[-0.02em] text-foreground'

/** The public setup guide for every supported agent client (RFC 026). */
export default function AgentsDocsPage() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <Navigation />
      <main className="mx-auto max-w-3xl flex-1 px-6 pt-28 pb-16 sm:pb-24">
        <h1
          className="mb-4 text-3xl font-semibold tracking-[-0.03em] text-foreground sm:text-4xl"
          style={{ fontFamily: INTER }}
        >
          Connect AI agents to Shots
        </h1>
        <p className="mb-6 text-lg leading-relaxed text-muted-foreground">
          The Shots MCP server lets an AI agent write, schedule, and publish posts to your connected
          accounts, with the same scopes, plan checks, and quotas as the{' '}
          <Link className={linkClassName} href="/api-reference">
            REST API
          </Link>
          . It can also read releases and campaigns, draft campaigns, upload assets, capture
          screenshots, and submit drafts for review. Posting needs the post:publish scope, which is
          off until you tick it. Only a person approves, in Shots; no agent can.
        </p>
        <pre className={codeBlockClassName}>
          <code>{MCP_URL}</code>
        </pre>

        <div className="mt-12 space-y-12">
          <section id="publishing">
            <h2 className={heading} style={{ fontFamily: INTER }}>
              Publish from your agent
            </h2>
            <p className="mb-4 leading-relaxed text-muted-foreground">
              Ask your agent to write a post and say which accounts and when. It finds the accounts
              with listSocialSets, uploads any media, and calls createPost, which schedules or
              publishes in one step. Check what it will post before you say yes: with post:publish
              there is no review in Shots, unless the workspace requires approval, in which case the
              post waits there and nothing goes out. A retry never posts twice.
            </p>
            <ul className="mb-4 list-disc space-y-2 pl-5 leading-relaxed text-muted-foreground">
              <li>
                <strong className="font-medium text-foreground">Only tick post:publish if you trust what drives the agent.</strong>{' '}
                Text an agent reads from a web page or a file could try to talk it into posting. Add
                post:schedule as well if you want it to be able to cancel scheduled posts.
              </li>
              <li>
                <strong className="font-medium text-foreground">Accounts must be in a shared social set.</strong>{' '}
                Agents can&apos;t see private sets or connect accounts, so connect them in Shots and
                share the set first.
              </li>
              <li>
                <strong className="font-medium text-foreground">Media needs a client that can upload files.</strong>{' '}
                Claude Code, Codex, and OpenCode can. Claude.ai and ChatGPT may only manage text, so
                attach media in Shots for those.
              </li>
              <li>
                <strong className="font-medium text-foreground">A post can take up to a minute to start.</strong>{' '}
                The agent can read each account&apos;s result and live link with
                listContentDraftPosts.
              </li>
            </ul>
          </section>

          <section id="authentication">
            <h2 className={heading} style={{ fontFamily: INTER }}>
              Authentication
            </h2>
            <p className="mb-4 leading-relaxed text-muted-foreground">
              Every call acts for one workspace. Agents that take a header send a workspace API key
              as <code>Authorization: Bearer ss_…</code>; create one in Settings → AI agents with
              only the scopes the agent needs. Claude.ai, Claude Desktop, and ChatGPT connect
              through OAuth, and Claude Code, Codex, and OpenCode can too: you sign in to Shots,
              choose the scopes, and approve. The token
              they receive is a workspace API key with exactly those scopes, listed and revocable in
              Settings.
            </p>
            <div className="overflow-x-auto">
              <Table className="w-full text-left text-sm">
                <TableHeader>
                  <TableRow className="border-b border-border">
                    <TableHead className="whitespace-normal py-2 pr-4 font-medium text-foreground">Scope</TableHead>
                    <TableHead className="whitespace-normal py-2 font-medium text-foreground">Lets the agent</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {apiKeyScopes.map((scope) => (
                    <TableRow className="border-b border-border/60" key={scope}>
                      <TableCell className="whitespace-normal py-2 pr-4 font-mono text-xs text-foreground">{scope}</TableCell>
                      <TableCell className="whitespace-normal py-2 text-muted-foreground">
                        {apiKeyScopeDescriptions[scope]}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="mt-4 leading-relaxed text-muted-foreground">
              Calls pass the same checks as the API: the key&apos;s scope, an active plan, the
              operation&apos;s feature, and its quota. Each key may make 60 calls a minute. Refusals
              use the{' '}
              <Link className={linkClassName} href="/api-reference#errors">
                API error envelope
              </Link>
              .
            </p>
          </section>

          <section id="tools">
            <h2 className={heading} style={{ fontFamily: INTER }}>
              Tools
            </h2>
            <p className="mb-4 leading-relaxed text-muted-foreground">
              Each tool is named after the API operation it mirrors and takes the same input. An
              agent sees only the tools its key&apos;s scopes allow.
            </p>
            <div className="overflow-x-auto">
              <Table className="w-full text-left text-sm">
                <TableHeader>
                  <TableRow className="border-b border-border">
                    <TableHead className="whitespace-normal py-2 pr-4 font-medium text-foreground">Tool</TableHead>
                    <TableHead className="whitespace-normal py-2 pr-4 font-medium text-foreground">Scope</TableHead>
                    <TableHead className="whitespace-normal py-2 font-medium text-foreground">Does</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {MCP_TOOLS.map((tool) => (
                    <TableRow className="border-b border-border/60" key={tool.name}>
                      <TableCell className="whitespace-normal py-2 pr-4 font-mono text-xs text-foreground">{tool.name}</TableCell>
                      <TableCell className="whitespace-normal py-2 pr-4 font-mono text-xs text-muted-foreground">
                        {tool.scope}
                      </TableCell>
                      <TableCell className="whitespace-normal py-2 text-muted-foreground">{tool.summary}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>

          {MCP_CLIENTS.map((client) => (
            <section id={client.id} key={client.id}>
              <h2 className={heading} style={{ fontFamily: INTER }}>
                {client.name}
              </h2>
              <p className="mb-3 text-sm text-muted-foreground">{client.location}</p>
              <pre className={codeBlockClassName}>
                <code>{client.snippet(MCP_URL, API_KEY_PLACEHOLDER)}</code>
              </pre>
              <ol className="mt-4 list-decimal space-y-1 pl-5 leading-relaxed text-muted-foreground">
                {client.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </section>
          ))}

          <section id="reference">
            <h2 className={heading} style={{ fontFamily: INTER }}>
              Reference
            </h2>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>
                <Link className={linkClassName} href="/openapi.json">
                  OpenAPI 3.1 document
                </Link>
                : the contract every tool&apos;s schema is generated from.
              </li>
              <li>
                <Link className={linkClassName} href="/api-reference">
                  Interactive API reference
                </Link>
                , with a quickstart.
              </li>
              <li>
                <Link className={linkClassName} href="/llms.txt">
                  llms.txt
                </Link>{' '}
                for agents reading the site.
              </li>
            </ul>
          </section>
        </div>
      </main>
      <Footer />
    </div>
  )
}
