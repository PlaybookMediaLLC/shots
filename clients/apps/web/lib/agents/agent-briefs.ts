/**
 * Single-source Markdown instruction briefs for AI agents ("Give this guide to
 * <Agent>" + /docs/agents/<agentId>.md). Derived directly from MCP_CLIENTS,
 * MCP_TOOLS, and apiKeyScopeDescriptions so tool lists and scope rules never drift.
 */

import {
  API_KEY_PLACEHOLDER,
  DEFAULT_AGENT_PROMPT,
  findMcpClient,
  MCP_TOOLS,
  MCP_URL,
  type McpClientGuide,
} from '@/lib/agents/mcp-clients'
import { SITE_URL } from '@/lib/seo/metadata'
import { apiKeyScopeDescriptions, apiKeyScopes } from '@/lib/auth/api-key-scopes'

/** Public Markdown guide path for one client (or `"guide"` for the universal manual). */
export function agentGuideMarkdownPath(agentId: string): string {
  return `/docs/agents/${encodeURIComponent(agentId)}.md`
}

function renderToolsTable(): string {
  const rows = MCP_TOOLS.map((tool) => `| \`${tool.name}\` | \`${tool.scope}\` | ${tool.summary} |`)
  return ['| Tool | Required scope | Purpose |', '| --- | --- | --- |', ...rows].join('\n')
}

function renderScopesList(): string {
  return apiKeyScopes
    .map((scope) => `- \`${scope}\`: ${apiKeyScopeDescriptions[scope]}`)
    .join('\n')
}

function renderConnectionSection(client: McpClientGuide | null, mcpUrl: string, origin: string): string {
  if (!client) {
    return [
      '## Connect to Shots',
      '',
      `- **MCP endpoint (Streamable HTTP + OAuth 2.1):** \`${mcpUrl}\``,
      `- **REST API reference:** ${origin}/api-reference`,
      `- **OpenAPI 3.1 contract:** ${origin}/openapi.json`,
      `- **Auth:** MCP accepts OAuth 2.1 with PKCE or a workspace API key in \`Authorization: Bearer ss_...\` / \`X-API-Key: ss_...\`; REST (\`/api/v1/*\`) accepts a workspace API key in \`X-API-Key: ss_...\`.`,
    ].join('\n')
  }
  const snippet = client.snippet(mcpUrl, API_KEY_PLACEHOLDER, origin)
  const fenceLang = client.language === 'prompt' ? 'text' : client.language
  const lines = [
    `## Connect ${client.name} to Shots`,
    '',
    `**${client.headline}** (${client.badge.label})`,
    '',
    `Where to configure: ${client.location}`,
    '',
    ...client.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    `\`\`\`${fenceLang}`,
    snippet,
    '```',
  ]
  if (client.note) {
    lines.push('', client.note)
  }
  if (client.fallback) {
    lines.push(
      '',
      `### Alternate setup: ${client.fallback.triggerLabel}`,
      '',
      `\`\`\`${client.fallback.language}`,
      client.fallback.snippet(mcpUrl, API_KEY_PLACEHOLDER, origin),
      '```',
      '',
      ...client.fallback.steps.map((step) => `- ${step}`)
    )
  }
  return lines.join('\n')
}

/**
 * Render the complete paste-ready Markdown manual for a specific agent ID
 * (or `"guide"` for the universal manual). Returns `null` for unknown IDs.
 */
export function buildAgentBriefMarkdown(
  agentId: string,
  options?: { mcpUrl?: string; origin?: string }
): string | null {
  const normalized = agentId.trim().toLowerCase()
  const client = normalized === 'guide' ? null : (findMcpClient(normalized) ?? null)
  if (normalized !== 'guide' && !client) return null

  const mcpUrl = options?.mcpUrl ?? MCP_URL
  const origin = (options?.origin ?? SITE_URL).replace(/\/+$/, '')
  const heading = client ? `# Shots Agent Guide for ${client.name}` : '# Shots Agent Guide'

  return [
    heading,
    '',
    '> Shots is a release-readiness and social publishing platform. This guide explains how to connect, discover accounts, upload media, create drafts, run release campaigns, and publish safely.',
    '',
    renderConnectionSection(client, mcpUrl, origin),
    '',
    '## Core Workflows',
    '',
    '### 1. Publish or schedule a post (`createPost`)',
    'Everything published reaches real public accounts. **Before calling `createPost`, show the user the exact copy, target accounts, and scheduled time, and wait for their explicit confirmation.**',
    '',
    '1. **Discover accounts:** Call `listSocialSets` to read `accounts[].id`, `platform`, `handle`, and connection health. Never invent account IDs. All accounts in one call must belong to the same shared social set.',
    '2. **Upload media (if needed):** Instagram, TikTok, and YouTube require media. Call `createAssetUploadUrl`, `PUT` the raw bytes to the signed `uploadUrl` with the declared `Content-Type` and `If-None-Match: *`, then call `completeAssetUpload` and pass the returned asset ID. `captureScreenshot` returns an image preview and does not create an upload asset.',
    '3. **Adapt copy per platform:** Set `posts` as the default (multiple items form a thread on X, Threads, Bluesky, and Mastodon), and override per platform via `platforms.<platform>.posts` and `platforms.<platform>.options` (`firstComment`, `visibility`, YouTube/TikTok settings).',
    '4. **Submit once with idempotency:** Call `createPost` with `channelConnectionIds`, `posts`, a fresh `idempotencyKey` (16–128 chars), and one timing mode (`publishNow`, `scheduledFor`, `localTime` + `timeZone`, or `queue`). Reuse the **same** `idempotencyKey` on timeouts/retries; never invent a new key for a retry.',
    '5. **Report verified outcomes:** Delivery can take up to a minute to start. Poll `listContentDraftPosts` for per-account `status` (`scheduled`, `processing`, `published`, `failed`, `unknown`), `url`, and `failureCode`. If `status` is `awaiting_approval`, the workspace requires human approval — share `<origin><reviewPath>` with the user.',
    '',
    '### 2. Draft for human review (`createContentDraft`)',
    '- Use `createContentDraft` when the user wants a teammate to review or edit before publishing, or when `post:publish` is not granted.',
    '- Read `getContentDraft` before editing and always pass the latest `baseVersion` to `updateContentDraft`. On `409 conflict`, reload and reconcile.',
    '- Share the review link at `' + origin + '/publish/<draftId>`.',
    '',
    '### 3. Release campaigns',
    '- Check `listReleases`, `listCampaigns`, and `listApprovals` first to avoid duplicate work.',
    '- Create a brief with `createRelease` (using an `idempotencyKey`), draft angles/posts with `createCampaign`, and submit for human review via `requestCampaignReview`.',
    '- Only schedule **already-approved** campaign posts via `scheduleCampaignPost` (requires `post:schedule`).',
    '',
    '## Platform Rules & Limits',
    '',
    '- **Character limits:** X 280 · Bluesky 300 · Threads 500 · Mastodon 500 · LinkedIn 3,000 · Instagram 2,200.',
    '- **Media required:** Instagram, TikTok, and YouTube require uploaded media assets.',
    '- **Private social sets:** Hidden from agents and API keys by design. If an account is missing, ask the user to connect or move it to a shared profile in Shots.',
    '- **Human-only approval:** No MCP tool or API key can approve content, change approval policy, or connect/disconnect social channels.',
    '- **Destructive actions:** `deleteAsset`, `cancelScheduledPost`, `deleteContentDraft`, and `deleteContentDraftPost` cannot be undone — confirm with the user first.',
    '- **Rate limits:** 60 calls/minute per key (20/minute for `captureScreenshot`) plus workspace plan quotas.',
    '',
    `## All ${MCP_TOOLS.length} Available MCP Tools`,
    '',
    'Discovery (`tools/list`) shows only tools allowed by your credential’s scopes. Every tool mirrors its operation in `' +
      origin +
      '/openapi.json`.',
    '',
    renderToolsTable(),
    '',
    '## Scopes',
    '',
    renderScopesList(),
    '',
    '## Example Requests',
    '',
    `- "${DEFAULT_AGENT_PROMPT}"`,
    '- "List my connected social accounts and suggest the best posting times this week."',
    '- "Save a LinkedIn and X launch draft from our latest release for team review."',
    '- "Check the delivery status and live links for my most recent scheduled posts."',
    '',
    '## Links',
    '',
    `- Full setup docs: ${origin}/docs/agents`,
    `- Interactive API reference: ${origin}/api-reference`,
    `- OpenAPI 3.1 JSON: ${origin}/openapi.json`,
    `- Webhooks guide (HMAC-SHA256, \`post.completed\`, \`connection.needs_reconnect\`): ${origin}/docs/api/webhooks`,
    '',
  ].join('\n')
}
