/**
 * How each AI agent client connects to the Shots MCP server and REST API (RFC 026).
 * One source for the public guide at /docs/agents, Settings → Agents & API keys,
 * per-agent Markdown briefs (/docs/agents/<id>.md), and /llms-full.txt, so a
 * snippet or tool rule is never copied by hand into multiple places.
 */

import { SITE_URL } from '@/lib/seo/metadata'

/** The public MCP endpoint for this deployment: the Go backend, never Next.js. */
export const MCP_URL = process.env.PLATFORM_MCP_URL ?? 'https://shots-mcp.playbookmedia.io/mcp'

/** The MCP base without `/mcp`, where the OAuth mounts live. */
export const MCP_BASE_URL = MCP_URL.replace(/\/mcp\/?$/, '')

/** Optional hosted connector directory URLs once listings are approved. */
export const CLAUDE_CONNECTOR_URL = process.env.NEXT_PUBLIC_CLAUDE_CONNECTOR_URL ?? ''
export const CHATGPT_CONNECTOR_URL = process.env.NEXT_PUBLIC_CHATGPT_CONNECTOR_URL ?? ''

/** Where the Shots plugin, skill, and CLI live. `main` is what production runs. */
const PLUGIN_REPOSITORY = 'PlaybookMediaLLC/shots'
const PLUGIN_PATH = 'clients/integrations/agent-plugin'
const CLI_PATH = 'clients/integrations/cli'

/** The Shots plugin's source, for people who want to read it first. */
export const PLUGIN_URL = `https://github.com/${PLUGIN_REPOSITORY}/tree/main/${PLUGIN_PATH}`

/** The Shots CLI's open-source package on GitHub. */
export const CLI_REPO_URL = `https://github.com/${PLUGIN_REPOSITORY}/tree/main/${CLI_PATH}`

/** Installs the plugin in Claude Code: the MCP server over OAuth, and the posting skill. */
export const CLAUDE_PLUGIN_INSTALL = `claude plugin marketplace add ${PLUGIN_REPOSITORY}@main && claude plugin install shots@shots`

/** Installs the posting skill where Codex and OpenCode both look for it. */
export const SKILL_INSTALL = `mkdir -p ~/.agents/skills/shots && curl -fsSL https://raw.githubusercontent.com/${PLUGIN_REPOSITORY}/main/${PLUGIN_PATH}/skills/shots/SKILL.md -o ~/.agents/skills/shots/SKILL.md`

/** Where OpenCode's API-key fallback snippet reads the key from until one is created on the page. */
const OPENCODE_KEY_FILE = '~/.config/opencode/shots-key'

/** The placeholder a snippet shows until a key is created on the page. */
export const API_KEY_PLACEHOLDER = '$SHOTS_API_KEY'

/** Prompt suggestion shown beneath each client's setup block. */
export const DEFAULT_AGENT_PROMPT =
  'post "hello from my agent" to my connected accounts tomorrow at 9am'

/** How a client authenticates. */
export type McpClientAuth = 'api-key' | 'oauth' | 'api-key-or-oauth'

/** Brand icon identifier rendered in the agent selector tabs and connected agents table. */
export type AgentIconId =
  | 'claude'
  | 'chatgpt'
  | 'codex'
  | 'opencode'
  | 'grok'
  | 'grokbot'
  | 'openclaw'
  | 'hermes'
  | 'cursor'
  | 'gemini'
  | 'muse'
  | 'cli'
  | 'mcp'

/** Optional collapsible secondary/manual setup instructions shown below the primary flow. */
export interface McpClientFallback {
  triggerLabel: string
  location: string
  language: 'bash' | 'json' | 'toml' | 'text'
  snippet: (mcpUrl: string, apiKey: string, origin?: string) => string
  steps: string[]
}

/** One agent client's setup guide and UI metadata. */
export interface McpClientGuide {
  id: string
  name: string
  /** Concise label shown on the horizontal agent tab bar. */
  tabLabel: string
  icon: AgentIconId
  auth: McpClientAuth
  /** Pill badge shown beside the setup headline. */
  badge: { label: string; tone: 'emerald' | 'neutral' }
  /** Short headline above the numbered setup steps. */
  headline: string
  /** Where the snippet goes: a command, connector screen, or config file. */
  location: string
  /** Numbered steps shown to connect this client. */
  steps: string[]
  /** Copy-paste configuration, URL, CLI command, or prompt for `mcpUrl` and an optional API key. */
  snippet: (mcpUrl: string, apiKey: string, origin?: string) => string
  /** The syntax language of the snippet, for display and formatting. */
  language: 'bash' | 'json' | 'toml' | 'text' | 'prompt'
  /** Whether the primary code block should be shown directly (false when a one-click directory CTA leads). */
  showPrimarySnippet?: boolean
  /** Optional primary button below the steps (e.g., Add to Claude, API reference, API docs). */
  primaryAction?: (origin: string) => { external?: boolean; href: string; label: string } | null
  /** Optional contextual helper note rendered beneath the primary setup block. */
  note?: string
  /** Optional collapsible manual / CLI / API-key fallback section. */
  fallback?: McpClientFallback
  /** Description inside the "Give this guide to <Agent>" callout box. */
  briefDescription: string
  /** Show the "or open as markdown" link next to "Copy for agent". */
  showMarkdownLink: boolean
}

function mount(mcpUrl: string, path: string): string {
  return mcpUrl.replace(/\/mcp\/?$/, path)
}

/** A literal key goes in quotes; the placeholder stays an environment reference. */
function bearer(apiKey: string, reference: string): string {
  return apiKey === API_KEY_PLACEHOLDER ? `Bearer ${reference}` : `Bearer ${apiKey}`
}

/** Standard Streamable HTTP MCP JSON block (OAuth via dynamic registration). */
function standardOAuthMcpJson(mcpUrl: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        shots: {
          type: 'http',
          url: mcpUrl,
        },
      },
    },
    null,
    2
  )
}

/** Standard Streamable HTTP MCP JSON block with Bearer API key header. */
function standardApiKeyMcpJson(mcpUrl: string, apiKey: string, envRef = '${env:SHOTS_API_KEY}'): string {
  return JSON.stringify(
    {
      mcpServers: {
        shots: {
          headers: { Authorization: bearer(apiKey, envRef) },
          type: 'http',
          url: mcpUrl,
        },
      },
    },
    null,
    2
  )
}

function resolveOrigin(origin?: string): string {
  return (origin || SITE_URL).replace(/\/+$/, '')
}

/** Every supported client, in the order Settings → Agents & API keys and /docs/agents list them. */
export const MCP_CLIENTS: McpClientGuide[] = [
  {
    auth: 'oauth',
    badge: {
      label: CLAUDE_CONNECTOR_URL ? 'RECOMMENDED' : 'OAuth',
      tone: CLAUDE_CONNECTOR_URL ? 'emerald' : 'neutral',
    },
    briefDescription:
      'Complete setup and usage manual: every Shots MCP tool, parameters, platform rules, media uploads, and common requests. Paste it into the chat.',
    fallback: {
      language: 'bash',
      location: 'Terminal (Claude Code) or Claude.ai → Settings → Connectors',
      snippet: (mcpUrl, apiKey) =>
        apiKey === API_KEY_PLACEHOLDER
          ? `claude mcp add --transport http shots ${mcpUrl}`
          : `claude mcp add --transport http shots ${mcpUrl} \\\n  --header "Authorization: Bearer ${apiKey}"`,
      steps: [
        'Run the command above, then run /mcp in Claude Code, pick shots, and approve OAuth in your browser.',
        `Or install the official Shots Claude Code plugin (MCP over OAuth + posting skill): ${CLAUDE_PLUGIN_INSTALL}`,
        'For Claude.ai / Claude Desktop custom connectors, paste the /mcp-oauth-claude URL above.',
      ],
      triggerLabel: 'Using Claude Code, or prefer to add manually?',
    },
    headline: CLAUDE_CONNECTOR_URL
      ? 'One-click from the Claude directory'
      : 'Connect in Claude.ai and Claude Desktop',
    icon: 'claude',
    id: 'claude',
    language: 'text',
    location: 'Claude.ai or Claude Desktop → Settings → Connectors → Add custom connector',
    name: 'Claude',
    note: 'Also works in Claude Code and Claude Desktop automatically once connected.',
    primaryAction: () =>
      CLAUDE_CONNECTOR_URL
        ? { external: true, href: CLAUDE_CONNECTOR_URL, label: 'Add to Claude' }
        : null,
    showMarkdownLink: true,
    showPrimarySnippet: !CLAUDE_CONNECTOR_URL,
    snippet: (mcpUrl) => mount(mcpUrl, '/mcp-oauth-claude'),
    steps: CLAUDE_CONNECTOR_URL
      ? [
          'Open Shots in the Claude connector directory',
          'Hit Connect and sign in with your Shots workspace',
          'That’s it! Claude has every Shots MCP tool scoped to what you approve',
        ]
      : [
          'Open Claude.ai → Settings → Connectors → Add custom connector',
          'Name it Shots, paste the URL below, hit Connect, and sign in with your Shots account',
          'Pick the scopes you want Claude to have — it works in Claude Desktop too',
        ],
    tabLabel: 'Claude',
  },
  {
    auth: 'oauth',
    badge: { label: 'OAuth', tone: 'neutral' },
    briefDescription:
      'Copies a short brief: how to connect if it has not yet, every Shots MCP tool, platform rules, and what to do with common requests. Paste it into the chat.',
    fallback: {
      language: 'text',
      location: 'ChatGPT → Settings → Apps & Connectors → Advanced → Developer mode',
      snippet: (mcpUrl) => mount(mcpUrl, '/mcp-oauth-chatgpt'),
      steps: [
        'When Shots is listed in the ChatGPT directory, it connects through /mcp-oauth-chatgpt with its registered client.',
        'For a developer-mode connector today, use /mcp-oauth-dynamic above so ChatGPT registers dynamically via OAuth.',
      ],
      triggerLabel: 'Using the listed directory endpoint?',
    },
    headline: 'Connect via ChatGPT Apps & Connectors',
    icon: 'chatgpt',
    id: 'chatgpt',
    language: 'text',
    location: 'ChatGPT → Settings → Apps & Connectors → Advanced → Developer mode → Create',
    name: 'ChatGPT',
    note: 'You choose exact scopes on the Shots consent page; posting requires ticking post:publish.',
    primaryAction: () =>
      CHATGPT_CONNECTOR_URL
        ? { external: true, href: CHATGPT_CONNECTOR_URL, label: 'Open in ChatGPT' }
        : null,
    showMarkdownLink: true,
    showPrimarySnippet: true,
    snippet: (mcpUrl) => mount(mcpUrl, '/mcp-oauth-dynamic'),
    steps: [
      'Open ChatGPT → Settings → Apps & Connectors → Developer mode → Create',
      'Name the connector Shots, paste the URL below, and choose OAuth',
      'Sign in to Shots when prompted, pick the scopes, and approve',
    ],
    tabLabel: 'ChatGPT',
  },
  {
    auth: 'api-key-or-oauth',
    badge: { label: 'OAuth via config', tone: 'neutral' },
    briefDescription:
      'Copies a short brief: how to connect Codex, the tools, platform rules, and common release/posting workflows. Paste it into the chat.',
    fallback: {
      language: 'toml',
      location: '~/.codex/config.toml (API key mode)',
      snippet: (mcpUrl, apiKey) =>
        apiKey === API_KEY_PLACEHOLDER
          ? `[mcp_servers.shots]\nurl = "${mcpUrl}"\nbearer_token_env_var = "SHOTS_API_KEY"`
          : `[mcp_servers.shots]\nurl = "${mcpUrl}"\nhttp_headers = { Authorization = "Bearer ${apiKey}" }`,
      steps: [
        'Use an API key in CI or headless runs where no browser is available for OAuth.',
        'Export SHOTS_API_KEY in the shell Codex runs in, then run codex mcp list.',
      ],
      triggerLabel: 'No browser for OAuth? Use an API key instead',
    },
    headline: 'Add Shots to Codex CLI or Desktop',
    icon: 'codex',
    id: 'codex',
    language: 'toml',
    location: '~/.codex/config.toml',
    name: 'Codex',
    note: `Add the Shots posting skill: ${SKILL_INSTALL}`,
    showMarkdownLink: false,
    showPrimarySnippet: true,
    snippet: (mcpUrl) => `[mcp_servers.shots]\nurl = "${mcpUrl}"`,
    steps: [
      'Add the block below to ~/.codex/config.toml',
      'Run codex mcp login shots and approve the OAuth prompt in your browser',
      `Optionally install the skill (${SKILL_INSTALL}) or Codex desktop plugin (codex plugin marketplace add ${PLUGIN_REPOSITORY}@main)`,
    ],
    tabLabel: 'Codex',
  },
  {
    auth: 'api-key-or-oauth',
    badge: { label: 'OAuth via config', tone: 'neutral' },
    briefDescription:
      'Copies a short brief: how to connect OpenCode, the tools, platform rules, and common requests. Paste it into the chat.',
    fallback: {
      language: 'json',
      location: 'opencode.json (API key file mode)',
      snippet: (mcpUrl, apiKey) =>
        JSON.stringify(
          {
            $schema: 'https://opencode.ai/config.json',
            mcp: {
              shots: {
                enabled: true,
                headers: { Authorization: bearer(apiKey, `{file:${OPENCODE_KEY_FILE}}`) },
                oauth: false,
                type: 'remote',
                url: mcpUrl,
              },
            },
          },
          null,
          2
        ),
      steps: [
        `Save your API key in ${OPENCODE_KEY_FILE}. A file works where shell env vars do not, because OpenCode’s background service cannot read your shell exports.`,
        'Run opencode mcp list to confirm Shots is connected.',
      ],
      triggerLabel: 'Prefer a key file instead of OAuth?',
    },
    headline: 'Connect Shots in OpenCode',
    icon: 'opencode',
    id: 'opencode',
    language: 'json',
    location: 'opencode.json in a project, or ~/.config/opencode/opencode.json',
    name: 'OpenCode',
    note: `Install the Shots posting skill for OpenCode: ${SKILL_INSTALL}`,
    showMarkdownLink: false,
    showPrimarySnippet: true,
    snippet: (mcpUrl) =>
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          mcp: {
            shots: {
              enabled: true,
              type: 'remote',
              url: mcpUrl,
            },
          },
        },
        null,
        2
      ),
    steps: [
      'Paste the config below into opencode.json or ~/.config/opencode/opencode.json',
      'Run opencode mcp auth shots and approve access in your browser',
      `Add the skill for writing and publishing posts: ${SKILL_INSTALL}`,
    ],
    tabLabel: 'OpenCode',
  },
  {
    auth: 'api-key-or-oauth',
    badge: { label: 'OAuth', tone: 'neutral' },
    briefDescription:
      'Copies a short brief: how to connect Grok, all Shots tools, platform rules, and common requests. Paste it into the chat.',
    fallback: {
      language: 'json',
      location: 'API key header (for builds without OAuth)',
      snippet: (mcpUrl, apiKey) => standardApiKeyMcpJson(mcpUrl, apiKey),
      steps: [
        'Create an API key with the button at the top of this page and send it as an Authorization: Bearer header.',
      ],
      triggerLabel: 'Need API key auth instead of OAuth?',
    },
    headline: 'Connect Shots as an MCP server in Grok',
    icon: 'grok',
    id: 'grok',
    language: 'text',
    location: 'Grok → Settings → Connectors / MCP Servers',
    name: 'Grok',
    note: 'MCP connector availability depends on your Grok plan and client build. If OAuth is unavailable, use an API key header.',
    showMarkdownLink: true,
    showPrimarySnippet: true,
    snippet: (mcpUrl) => mcpUrl,
    steps: [
      'Open Grok’s MCP server or connector settings and add a new remote MCP server',
      'Paste the Shots MCP URL below and sign in with your Shots workspace over OAuth',
      'Approve the scopes you want Grok to use — every Shots tool appears automatically',
    ],
    tabLabel: 'Grok',
  },
  {
    auth: 'api-key-or-oauth',
    badge: { label: 'OAuth via config', tone: 'neutral' },
    briefDescription:
      'Copies a short brief: how to connect Grokbot, the tools, platform rules, and what to do with common requests. Paste it into the chat.',
    fallback: {
      language: 'json',
      location: 'Grokbot MCP config (API key header)',
      snippet: (mcpUrl, apiKey) => standardApiKeyMcpJson(mcpUrl, apiKey),
      steps: [
        'Use an Authorization: Bearer header if your Grokbot runtime runs headlessly without browser OAuth.',
      ],
      triggerLabel: 'Running headlessly with an API key?',
    },
    headline: 'Paste one MCP config block into Grokbot',
    icon: 'grokbot',
    id: 'grokbot',
    language: 'json',
    location: 'Grokbot MCP settings',
    name: 'Grokbot',
    note: 'Same Streamable HTTP block works in any MCP-capable agent runtime.',
    showMarkdownLink: false,
    showPrimarySnippet: true,
    snippet: (mcpUrl) => standardOAuthMcpJson(mcpUrl),
    steps: [
      'Copy the MCP config block below into your Grokbot MCP settings',
      'Sign in and approve scopes when the OAuth prompt opens',
      'Every Shots tool shows up automatically',
    ],
    tabLabel: 'Grokbot',
  },
  {
    auth: 'api-key-or-oauth',
    badge: { label: 'OAuth via config', tone: 'neutral' },
    briefDescription:
      'Copies a short brief: how to connect OpenClaw, the tools, platform rules, and what to do with common requests. Paste it into the chat.',
    fallback: {
      language: 'json',
      location: 'OpenClaw MCP config (API key header)',
      snippet: (mcpUrl, apiKey) => standardApiKeyMcpJson(mcpUrl, apiKey),
      steps: [
        'Pass an API key in Authorization: Bearer when running OpenClaw unattended without OAuth.',
      ],
      triggerLabel: 'Using an API key instead of OAuth?',
    },
    headline: 'Paste one MCP config block into OpenClaw',
    icon: 'openclaw',
    id: 'openclaw',
    language: 'json',
    location: 'OpenClaw MCP server configuration',
    name: 'OpenClaw',
    note: 'OpenClaw can also load the Shots SKILL.md manual for platform formatting rules.',
    showMarkdownLink: false,
    showPrimarySnippet: true,
    snippet: (mcpUrl) => standardOAuthMcpJson(mcpUrl),
    steps: [
      'Copy the config block below into your OpenClaw MCP settings',
      'Complete the OAuth sign-in prompt and pick the scopes OpenClaw may use',
      'Every Shots tool shows up automatically',
    ],
    tabLabel: 'OpenClaw',
  },
  {
    auth: 'api-key-or-oauth',
    badge: { label: 'OAuth via config', tone: 'neutral' },
    briefDescription:
      'Copies a short brief: how to connect if it has not yet, the tools, platform rules, and what to do with common requests. Paste it into the chat.',
    fallback: {
      language: 'json',
      location: 'Hermes MCP settings (API key header)',
      snippet: (mcpUrl, apiKey) => standardApiKeyMcpJson(mcpUrl, apiKey),
      steps: [
        'No OAuth in your Hermes build? Add an Authorization: Bearer header with a key created above.',
      ],
      triggerLabel: 'Need API key auth instead?',
    },
    headline: 'Paste one MCP config block',
    icon: 'hermes',
    id: 'hermes',
    language: 'json',
    location: 'Hermes MCP settings',
    name: 'Hermes',
    note: 'Same block works in any MCP-capable agent.',
    showMarkdownLink: false,
    showPrimarySnippet: true,
    snippet: (mcpUrl) => standardOAuthMcpJson(mcpUrl),
    steps: [
      'Copy the config below into your Hermes MCP settings',
      'Sign in when the OAuth prompt appears',
      'Every Shots tool shows up automatically',
    ],
    tabLabel: 'Hermes',
  },
  {
    auth: 'api-key-or-oauth',
    badge: { label: 'OAuth via config', tone: 'neutral' },
    briefDescription:
      'Copies a short brief: how to connect if it has not yet, the tools, platform rules, and what to do with common requests. Paste it into the chat.',
    fallback: {
      language: 'json',
      location: 'VS Code (.vscode/mcp.json), Windsurf (~/.codeium/windsurf/mcp_config.json), or Cursor API key',
      snippet: (mcpUrl, apiKey) =>
        JSON.stringify(
          {
            inputs:
              apiKey === API_KEY_PLACEHOLDER
                ? [
                    {
                      description: 'Shots API key',
                      id: 'shots-api-key',
                      password: true,
                      type: 'promptString',
                    },
                  ]
                : [],
            servers: {
              shots: {
                headers: { Authorization: bearer(apiKey, '${input:shots-api-key}') },
                type: 'http',
                url: mcpUrl,
              },
            },
          },
          null,
          2
        ),
      steps: [
        'VS Code (GitHub Copilot): paste the JSON above into .vscode/mcp.json and select Start.',
        'Windsurf: put { "mcpServers": { "shots": { "serverUrl": "<same MCP URL above>", "headers": { "Authorization": "Bearer ${env:SHOTS_API_KEY}" } } } } in ~/.codeium/windsurf/mcp_config.json.',
        'Cursor without OAuth: add "headers": { "Authorization": "Bearer ${env:SHOTS_API_KEY}" } inside mcpServers.shots.',
      ],
      triggerLabel: 'Using VS Code, Windsurf, or an API key header?',
    },
    headline: 'Add Shots to your MCP config',
    icon: 'cursor',
    id: 'cursor',
    language: 'json',
    location: '~/.cursor/mcp.json (or .cursor/mcp.json in a project)',
    name: 'Cursor',
    note: 'Works the same in Windsurf and Claude Code. No OAuth in your build? Use the API key header in the disclosure below.',
    showMarkdownLink: false,
    showPrimarySnippet: true,
    snippet: (mcpUrl) => standardOAuthMcpJson(mcpUrl),
    steps: [
      'Paste the config below into ~/.cursor/mcp.json (Windsurf: mcp_config.json)',
      'Reload. First use opens the OAuth login in your browser',
      'Ship release notes and posts to socials without leaving the editor',
    ],
    tabLabel: 'Cursor',
  },
  {
    auth: 'api-key-or-oauth',
    badge: { label: 'OAuth', tone: 'neutral' },
    briefDescription:
      'Copies a short brief: how to connect if it has not yet, the tools, platform rules, and what to do with common requests. Paste it into the chat.',
    fallback: {
      language: 'bash',
      location: 'Terminal (Gemini CLI / Code Assist)',
      snippet: (mcpUrl, apiKey) =>
        apiKey === API_KEY_PLACEHOLDER
          ? `gemini mcp add --transport http shots ${mcpUrl}`
          : `gemini mcp add --transport http shots ${mcpUrl} \\\n  --header "Authorization: Bearer ${apiKey}"`,
      steps: [
        'The command writes the server to ~/.gemini/settings.json.',
        'Run /mcp auth shots in Gemini CLI to connect over OAuth, or pass --header with an API key.',
      ],
      triggerLabel: 'Using Gemini CLI or Code Assist instead?',
    },
    headline: 'Custom app in the Gemini web app',
    icon: 'gemini',
    id: 'gemini',
    language: 'text',
    location: 'Gemini web app → Settings & help → Connected apps → Custom apps for Spark',
    name: 'Gemini',
    note: 'Custom apps require Gemini Spark (Google AI Pro or Ultra, personal account, US, English); work accounts and other countries can use Gemini CLI below or ChatGPT/Claude instead. Once added on the web, it appears in the Gemini phone app too.',
    showMarkdownLink: true,
    showPrimarySnippet: true,
    snippet: (mcpUrl) => mcpUrl,
    steps: [
      'In the Gemini web app open Settings & help, then Connected apps, and under Custom apps for Spark click Add a custom app',
      'Paste the URL below, click Next, and approve Shots in the sign-in window that opens',
      'Ask Gemini to draft or post on the web or in the phone app — it gets every scope you approved',
    ],
    tabLabel: 'Gemini',
  },
  {
    auth: 'api-key',
    badge: { label: 'API key', tone: 'neutral' },
    briefDescription:
      'Copies a short brief: how to connect via the REST API, endpoints, platform rules, and what to do with common requests. Paste it into the chat.',
    headline: 'Muse writes its own connector from the API',
    icon: 'muse',
    id: 'muse',
    language: 'prompt',
    location: 'Paste into your Meta Muse conversation',
    name: 'Muse',
    note: 'Meta’s Muse has no MCP support yet, so it takes the REST API route and builds a connector directly from the OpenAPI reference. Treat the key like a password and revoke it from the API keys table above when done.',
    primaryAction: (origin) => ({
      external: true,
      href: `${resolveOrigin(origin)}/api-reference`,
      label: 'API reference',
    }),
    showMarkdownLink: false,
    showPrimarySnippet: true,
    snippet: (_mcpUrl, apiKey, origin) => {
      const base = resolveOrigin(origin)
      const token = apiKey === API_KEY_PLACEHOLDER ? 'YOUR_API_KEY' : apiKey
      return `Connect to Shots, my release and social publishing platform. The REST API reference is at ${base}/api-reference (OpenAPI JSON: ${base}/openapi.json). Authenticate with header X-API-Key: ${token}. Start by listing my social sets.`
    },
    steps: [
      'Create an API key with the button at the top of this page',
      'Send Muse the prompt below with your key pasted in. It reads the API reference and wires the connection itself',
      'Ask Muse to draft or post — releases, drafts, media uploads, and publishing are all in the API',
    ],
    tabLabel: 'Muse',
  },
  {
    auth: 'api-key',
    badge: { label: 'API key', tone: 'neutral' },
    briefDescription:
      'Copies a short brief: how to authenticate to the Shots REST API, verify a key, and call posting, release, and draft endpoints.',
    fallback: {
      language: 'bash',
      location: 'In-repo Shots CLI (clients/integrations/cli — not yet published to npm)',
      snippet: (_mcpUrl, apiKey) => {
        const token = apiKey === API_KEY_PLACEHOLDER ? 'YOUR_API_KEY' : apiKey
        return `node clients/integrations/cli/bin/shots.js setup --key ${token}`
      },
      steps: [
        'Clone PlaybookMediaLLC/shots (Apache 2.0) and run the command above with Node 22+ to save your key in ~/.config/shots/config.json.',
        'Use shots whoami, shots accounts list, shots posts create, shots drafts list, shots releases list, or shots code.',
      ],
      triggerLabel: 'Using the open-source Shots CLI from source?',
    },
    headline: 'No install, straight from the terminal',
    icon: 'cli',
    id: 'cli-api',
    language: 'bash',
    location: 'Terminal (curl or any HTTP client)',
    name: 'CLI / API',
    note: 'Every MCP tool mirrors a REST endpoint in /openapi.json. Send your workspace key in X-API-Key (include Idempotency-Key on POST /api/v1/posts and POST /api/v1/releases).',
    primaryAction: (origin) => ({
      external: true,
      href: `${resolveOrigin(origin)}/api-reference`,
      label: 'API docs',
    }),
    showMarkdownLink: false,
    showPrimarySnippet: true,
    snippet: (_mcpUrl, apiKey, origin) => {
      const base = resolveOrigin(origin)
      const token = apiKey === API_KEY_PLACEHOLDER ? 'YOUR_API_KEY' : apiKey
      return `curl -fsSL -H "X-API-Key: ${token}" ${base}/api/v1/auth/me`
    },
    steps: [
      'Create a workspace API key with the button at the top of this page',
      'Verify your key and workspace from any terminal with the curl command below',
      'Wire /api/v1/* endpoints into cron jobs, CI, Code Studio exports, or your own agent scripts',
    ],
    tabLabel: 'CLI / API',
  },
  {
    auth: 'api-key-or-oauth',
    badge: { label: 'OAuth via config', tone: 'neutral' },
    briefDescription:
      'Copies a short brief: how to connect if it has not yet, the tools, platform rules, and what to do with common requests. Paste it into the chat.',
    fallback: {
      language: 'json',
      location: 'stdio-only clients via npx mcp-remote',
      snippet: (mcpUrl, apiKey) =>
        JSON.stringify(
          {
            mcpServers: {
              shots: {
                args:
                  apiKey === API_KEY_PLACEHOLDER
                    ? ['-y', 'mcp-remote', mcpUrl]
                    : ['-y', 'mcp-remote', mcpUrl, '--header', `Authorization:Bearer ${apiKey}`],
                command: 'npx',
              },
            },
          },
          null,
          2
        ),
      steps: [
        'Use mcp-remote when a client only speaks local stdio MCP instead of Streamable HTTP.',
        'Without --header, mcp-remote opens Shots OAuth in your browser automatically.',
      ],
      triggerLabel: 'Using a stdio-only client or API key header?',
    },
    headline: 'One URL, works in any MCP-capable agent',
    icon: 'mcp',
    id: 'any-mcp',
    language: 'json',
    location: 'Any MCP client configuration file',
    name: 'Any MCP client',
    note: 'stdio-only client? Bridge it with npx mcp-remote and the same URL. No OAuth in your client? Use an API key in an Authorization: Bearer header.',
    primaryAction: () => ({
      external: false,
      href: '/docs/agents',
      label: 'Setup docs per client',
    }),
    showMarkdownLink: false,
    showPrimarySnippet: true,
    snippet: (mcpUrl) => standardOAuthMcpJson(mcpUrl),
    steps: [
      'Add the config below wherever your agent lists MCP servers (Windsurf, Zed, VS Code, your own framework)',
      'First use opens the Shots login in your browser. Pick scopes and approve it',
      'Every approved Shots tool shows up automatically',
    ],
    tabLabel: 'Any MCP client',
  },
]

/** Look up one client guide by id. */
export function findMcpClient(id: string): McpClientGuide | undefined {
  return MCP_CLIENTS.find((client) => client.id === id)
}

/** The tools agents get, by the scope that grants them (RFC 026). */
export const MCP_TOOLS: { name: string; scope: string; summary: string }[] = [
  { name: 'listReleases', scope: 'artifact:read', summary: 'List the workspace releases' },
  { name: 'createRelease', scope: 'release:create', summary: 'Create a release brief' },
  { name: 'createAssetUploadUrl', scope: 'upload:sign', summary: 'Sign an asset upload' },
  { name: 'completeAssetUpload', scope: 'asset:write', summary: 'Complete an asset upload' },
  { name: 'createAssetDownloadUrl', scope: 'artifact:read', summary: 'Sign an asset download' },
  { name: 'deleteAsset', scope: 'asset:write', summary: 'Delete an asset (asks to confirm)' },
  { name: 'captureScreenshot', scope: 'artifact:read', summary: 'Screenshot a public page' },
  { name: 'listCampaigns', scope: 'artifact:read', summary: 'List campaigns' },
  { name: 'getCampaign', scope: 'artifact:read', summary: 'Read a campaign and its posts' },
  { name: 'createCampaign', scope: 'release:create', summary: 'Create a draft campaign' },
  { name: 'listApprovals', scope: 'artifact:read', summary: 'List posts waiting for review' },
  { name: 'requestCampaignReview', scope: 'release:create', summary: 'Submit drafts for review' },
  { name: 'scheduleCampaignPost', scope: 'post:schedule', summary: 'Schedule an approved post' },
  { name: 'listScheduledPosts', scope: 'artifact:read', summary: 'List the publishing schedule' },
  { name: 'createScheduledPost', scope: 'post:schedule', summary: 'Schedule an approved post with its visual' },
  {
    name: 'cancelScheduledPost',
    scope: 'post:schedule',
    summary: 'Cancel a scheduled post (asks to confirm)',
  },
  { name: 'listSocialSets', scope: 'artifact:read', summary: 'List visible social sets' },
  {
    name: 'getSocialSet',
    scope: 'artifact:read',
    summary: 'Read a social set and its queue settings',
  },
  {
    name: 'updateSocialSetQueue',
    scope: 'queue:write',
    summary: 'Change future posting-slot defaults; never moves or publishes existing posts.',
  },
  {
    name: 'lookupSocialSetMentions',
    scope: 'artifact:read',
    summary: 'Look up an X username or LinkedIn company with a visible set’s account.',
  },
  {
    name: 'listCalendarPosts',
    scope: 'artifact:read',
    summary: 'Read visible deliveries in a bounded date range',
  },
  {
    name: 'bestPostingTimes',
    scope: 'artifact:read',
    summary: 'Suggest posting times for one social set',
  },
  {
    name: 'listContentDrafts',
    scope: 'artifact:read',
    summary: 'Find drafts by text, set, and status',
  },
  {
    name: 'getContentDraft',
    scope: 'artifact:read',
    summary: 'Read an editable draft and its version',
  },
  { name: 'createContentDraft', scope: 'draft:write', summary: 'Create a draft for human review' },
  {
    name: 'createPost',
    scope: 'post:publish',
    summary: 'Write and publish a post or thread (asks to confirm)',
  },
  {
    name: 'updateContentDraft',
    scope: 'draft:write',
    summary: 'Update a draft using its current version',
  },
  {
    name: 'deleteContentDraft',
    scope: 'draft:write',
    summary: 'Delete an unscheduled draft (asks to confirm)',
  },
  {
    name: 'listContentDraftPosts',
    scope: 'artifact:read',
    summary: 'Inspect draft delivery outcomes',
  },
  {
    name: 'deleteContentDraftPost',
    scope: 'post:delete',
    summary: 'Delete a published post from its platform (asks to confirm)',
  },
  {
    name: 'planContentDraft',
    scope: 'draft:write',
    summary: 'Set a planning date; does not schedule or publish',
  },
  { name: 'duplicateContentDraft', scope: 'draft:write', summary: 'Copy a draft for repurposing' },
  {
    name: 'updateContentDraftProperties',
    scope: 'draft:write',
    summary: 'Change draft tags, pin, or scratchpad',
  },
  {
    name: 'listContentDraftActivity',
    scope: 'artifact:read',
    summary: 'Read draft activity without private comment text',
  },
  { name: 'listDraftComments', scope: 'artifact:read', summary: 'Read filtered draft discussion threads.' },
  {
    name: 'mutateDraftComment',
    scope: 'draft:comment',
    summary: 'Comment as the key, reply, edit your own comments, resolve or delete authorized discussions.',
  },
]
