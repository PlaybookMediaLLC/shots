import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  API_KEY_PLACEHOLDER,
  CLAUDE_PLUGIN_INSTALL,
  MCP_CLIENTS,
  MCP_TOOLS,
  MCP_URL,
  PLUGIN_URL,
  SKILL_INSTALL,
} from '@/lib/agents/mcp-clients'
import { openApiSpec } from '@/lib/api/openapi'

const url = 'https://api.shots.test/mcp'

test('every client snippet is a valid configuration that points at the Go MCP server', () => {
  for (const client of MCP_CLIENTS) {
    for (const key of [API_KEY_PLACEHOLDER, 'ss_live_key']) {
      const snippet = client.snippet(url, key)
      assert.match(
        snippet,
        /https:\/\/api\.shots\.test\/mcp(-oauth-(claude|chatgpt|dynamic))?/,
        client.id
      )
      if (client.language === 'json') assert.doesNotThrow(() => JSON.parse(snippet), client.id)
      if (client.auth === 'oauth') {
        assert.doesNotMatch(snippet, /ss_live_key/, `${client.id} must not embed a key`)
        continue
      }
      if (key === API_KEY_PLACEHOLDER) {
        assert.doesNotMatch(snippet, /ss_live_key/, client.id)
      } else {
        assert.match(snippet, /Bearer ss_live_key/, `${client.id} must use the created key`)
      }
    }
    assert.ok(client.steps.length > 0, client.id)
  }
  assert.deepEqual(
    MCP_CLIENTS.map((client) => client.id),
    [
      'claude-code',
      'claude',
      'chatgpt',
      'cursor',
      'vscode',
      'windsurf',
      'gemini-cli',
      'codex',
      'opencode',
    ]
  )
})

test('the documented tools are the Go tool table, with the scopes the spec declares', () => {
  const source = readFileSync('../../../server/internal/mcp/tools.go', 'utf8')
  const goTools = [...source.matchAll(/^\t\{"(\w+)", \w+,/gm)].map((match) => match[1])
  assert.deepEqual(
    MCP_TOOLS.map((tool) => tool.name),
    goTools
  )
  const operations = Object.values(openApiSpec.paths).flatMap((item) =>
    Object.values(
      item as Record<string, { operationId?: string; security?: Record<string, string[]>[] }>
    )
  )
  for (const tool of MCP_TOOLS) {
    const operation = operations.find((candidate) => candidate.operationId === tool.name)
    const scopes = operation?.security?.flatMap((requirement) => requirement.workspaceApiKey ?? [])
    assert.deepEqual(scopes, [tool.scope], tool.name)
  }
})

const ROOT = '../../..'
const PLUGIN = `${ROOT}/clients/integrations/agent-plugin`
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

test('the plugin connects Claude and Codex to the same server, at one version', () => {
  const claude = readJson(`${PLUGIN}/.mcp.json`).mcpServers.shots
  const codex = readJson(`${PLUGIN}/mcp.json`).mcpServers.shots
  assert.equal(claude.url, MCP_URL)
  assert.equal(codex.url, MCP_URL)
  // Claude Code and Codex each name the transport their own way.
  assert.equal(claude.type, 'http')
  assert.equal(codex.type, 'streamable-http')
  assert.equal(
    readJson(`${PLUGIN}/.claude-plugin/plugin.json`).version,
    readJson(`${PLUGIN}/plugin.json`).version,
    'updates follow the version: bump both'
  )
})

test('both marketplaces point at the plugin, and the guides install it from there', () => {
  const path = './clients/integrations/agent-plugin'
  assert.equal(readJson(`${ROOT}/.claude-plugin/marketplace.json`).plugins[0].source, path)
  assert.equal(readJson(`${ROOT}/.agents/plugins/marketplace.json`).plugins[0].source.path, path)
  assert.ok(PLUGIN_URL.endsWith('/tree/main/clients/integrations/agent-plugin'), PLUGIN_URL)
  assert.match(CLAUDE_PLUGIN_INSTALL, /PlaybookMediaLLC\/shots@main/)
  assert.match(
    SKILL_INSTALL,
    /\/main\/clients\/integrations\/agent-plugin\/skills\/shots\/SKILL\.md/
  )
  for (const id of ['codex', 'opencode']) {
    const steps = MCP_CLIENTS.find((client) => client.id === id)?.steps ?? []
    assert.ok(
      steps.some((step) => step.includes(SKILL_INSTALL)),
      `${id} must offer the skill`
    )
  }
})

test('the skill names only tools that exist, and leads with publishing', () => {
  const skill = readFileSync(`${PLUGIN}/skills/shots/SKILL.md`, 'utf8')
  const tools = new Set(MCP_TOOLS.map((tool) => tool.name))
  const named = [
    ...skill.matchAll(
      /`((?:list|get|create|update|delete|plan|duplicate|mutate|cancel|schedule|complete|capture|request|lookup|best)[A-Z]\w+)`/g
    ),
  ]
  assert.ok(named.length > 20)
  for (const [, name] of named) assert.ok(tools.has(name!), `${name} is not a tool`)
  assert.match(skill, /createPost/)
  assert.match(skill, /get their yes/, 'the skill must make the agent confirm before posting')
  assert.doesNotMatch(skill, /no tool to approve or schedule/)
})

test('the setup snippets match what each client documents', () => {
  const opencode = MCP_CLIENTS.find((client) => client.id === 'opencode')
  const config = JSON.parse(opencode!.snippet(url, API_KEY_PLACEHOLDER)).mcp.shots
  assert.equal(config.oauth, false, 'OpenCode tries OAuth on a key server unless told not to')
  // Not {env:…}: OpenCode's background service resolves that against its own
  // environment, so a key exported in a shell arrives empty and the server refuses it.
  assert.equal(config.headers.Authorization, 'Bearer {file:~/.config/opencode/shots-key}')
  const codex = MCP_CLIENTS.find((client) => client.id === 'codex')
  assert.match(codex!.snippet(url, API_KEY_PLACEHOLDER), /bearer_token_env_var = "SHOTS_API_KEY"/)
  assert.ok(codex!.steps.some((step) => step.includes('codex mcp login shots')))
})
