import assert from 'node:assert/strict'
import test from 'node:test'
import { GET as getMarkdownRoute } from '@/app/api/md/[...path]/route'
import {
  detectAgentIcon,
  formatCredentialTimestamp,
  groupConnectedAgents,
  summarizeScopes,
  type WorkspaceCredential,
} from '@/components/settings/agents/scope-summary'
import {
  apiKeyScopes,
  permissionsForApiKeyScopes,
  scopesFromPermissions,
} from '@/lib/auth/api-key-scopes'

test('scopesFromPermissions round-trips every canonical scope and drops unknown entries', () => {
  const encoded = JSON.stringify(permissionsForApiKeyScopes(apiKeyScopes))
  assert.deepEqual(scopesFromPermissions(encoded), [...apiKeyScopes].sort())
  assert.deepEqual(
    scopesFromPermissions({ artifact: ['read', 'bogus'], unknown: ['write'], post: ['publish'] }),
    ['artifact:read', 'post:publish']
  )
  assert.deepEqual(scopesFromPermissions('not-json'), [])
  assert.deepEqual(scopesFromPermissions(null), [])
})

test('summarizeScopes never claims blanket full access and highlights high-trust scopes', () => {
  assert.deepEqual(summarizeScopes([]), {
    highTrust: false,
    label: 'No scopes',
    scopes: [],
    tone: 'gray',
  })
  assert.deepEqual(summarizeScopes(['artifact:read']), {
    highTrust: false,
    label: 'Read only',
    scopes: ['artifact:read'],
    tone: 'gray',
  })
  assert.deepEqual(summarizeScopes(['artifact:read', 'draft:write', 'draft:write']), {
    highTrust: false,
    label: 'Read & Draft (2)',
    scopes: ['artifact:read', 'draft:write'],
    tone: 'green',
  })
  const sched = summarizeScopes(['artifact:read', 'post:schedule'])
  assert.equal(sched.highTrust, false)
  assert.equal(sched.tone, 'blue')
  assert.match(sched.label, /Scheduling/)

  const pub = summarizeScopes(['artifact:read', 'post:publish'])
  assert.equal(pub.highTrust, true)
  assert.equal(pub.tone, 'yellow')
  assert.match(pub.label, /Direct Publishing/)

  const del = summarizeScopes(['post:delete'])
  assert.equal(del.highTrust, true)
  assert.equal(del.tone, 'yellow')
  assert.match(del.label, /Delete/)

  const both = summarizeScopes(['post:publish', 'post:delete'])
  assert.equal(both.highTrust, true)
  assert.match(both.label, /Publish & Delete/)

  assert.equal(formatCredentialTimestamp(null), 'Never')
  assert.equal(formatCredentialTimestamp('not-a-date'), '—')
  assert.notEqual(formatCredentialTimestamp('2026-10-20T06:28:00Z'), '—')
})

test('groupConnectedAgents collapses multi-session OAuth clients and excludes REST/disabled/expired keys', () => {
  const now = Date.parse('2026-11-28T12:00:00Z')
  const keys: WorkspaceCredential[] = [
    {
      agentClient: 'Claude Code',
      agentSession: { clientId: 'pcd_claude', clientName: 'Claude Code', grantId: 'g1' },
      createdAt: '2026-10-20T06:28:00Z',
      enabled: true,
      expiresAt: null,
      id: 'k1',
      lastRequest: '2026-10-20T06:28:00Z',
      name: 'Claude Code (AI agent)',
      prefix: 'ss_',
      scopes: ['artifact:read', 'draft:write'],
      start: 'ss_aaa',
    },
    {
      agentClient: 'Claude Code',
      agentSession: { clientId: 'pcd_claude', clientName: 'Claude Code', grantId: 'g2' },
      createdAt: '2026-10-21T07:10:00Z',
      enabled: true,
      expiresAt: null,
      id: 'k2',
      lastRequest: '2026-10-21T07:10:00Z',
      name: 'Claude Code (AI agent)',
      prefix: 'ss_',
      scopes: ['artifact:read', 'post:publish'],
      start: 'ss_bbb',
    },
    {
      agentClient: 'Codex',
      agentSession: { clientId: 'pcd_codex', clientName: 'Codex', grantId: 'g3' },
      createdAt: '2026-08-30T11:48:00Z',
      enabled: true,
      expiresAt: null,
      id: 'k3',
      lastRequest: null,
      name: 'Codex (AI agent)',
      prefix: 'ss_',
      scopes: ['artifact:read'],
      start: 'ss_ccc',
    },
    {
      // Name-only legacy OAuth session groups case-insensitively without colliding with pcd_claude.
      agentClient: 'Claude Code',
      agentSession: { clientId: '', clientName: 'Claude Code', grantId: null },
      createdAt: '2026-08-15T10:00:00Z',
      enabled: true,
      expiresAt: null,
      id: 'k_legacy',
      lastRequest: null,
      name: 'Claude Code (AI agent)',
      prefix: 'ss_',
      scopes: ['artifact:read'],
      start: 'ss_leg',
    },
    {
      // Disabled OAuth session: excluded from active connected agents.
      agentClient: 'Hermes',
      agentSession: { clientId: 'pcd_hermes', clientName: 'Hermes', grantId: 'g5' },
      createdAt: '2026-11-10T00:00:00Z',
      enabled: false,
      expiresAt: null,
      id: 'k_disabled',
      lastRequest: null,
      name: 'Hermes (AI agent)',
      prefix: 'ss_',
      scopes: ['artifact:read'],
      start: 'ss_dis',
    },
    {
      // Manual REST key: must never appear in Connected agents.
      agentClient: null,
      agentSession: null,
      createdAt: '2026-11-01T00:00:00Z',
      enabled: true,
      expiresAt: null,
      id: 'k_rest',
      lastRequest: null,
      name: 'CI deploy key',
      prefix: 'ss_',
      scopes: ['artifact:read'],
      start: 'ss_ddd',
    },
    {
      // Expired OAuth session: excluded from active connected agents.
      agentClient: 'Cursor',
      agentSession: { clientId: 'pcd_cursor', clientName: 'Cursor', grantId: 'g4' },
      createdAt: '2026-01-01T00:00:00Z',
      enabled: true,
      expiresAt: '2026-02-01T00:00:00Z',
      id: 'k_expired',
      lastRequest: null,
      name: 'Cursor (AI agent)',
      prefix: 'ss_',
      scopes: ['artifact:read'],
      start: 'ss_eee',
    },
  ]

  const groups = groupConnectedAgents(keys, now)
  assert.equal(groups.length, 3)
  assert.equal(groups[0]!.clientName, 'Claude Code')
  assert.equal(groups[0]!.clientId, 'pcd_claude')
  assert.equal(groups[0]!.sessions.length, 2)
  assert.equal(groups[0]!.sessions[0]!.id, 'k2')
  assert.deepEqual(groups[0]!.scopes, ['artifact:read', 'draft:write', 'post:publish'])
  assert.equal(groups[0]!.icon, 'claude')
  assert.equal(groups[1]!.clientName, 'Codex')
  assert.equal(groups[1]!.sessions.length, 1)
  assert.equal(groups[1]!.icon, 'codex')
  assert.equal(groups[2]!.groupKey, 'name:claude code')
  assert.equal(groups[2]!.sessions.length, 1)
  assert.equal(detectAgentIcon('Grokbot'), 'grokbot')
  assert.equal(detectAgentIcon('Grok'), 'grok')
  assert.equal(detectAgentIcon('Meta Muse'), 'muse')
  assert.equal(detectAgentIcon('Custom MCP Bot'), 'mcp')
})

test('GET /api/md/docs/agents/<agentId>.md serves text/markdown for valid agents and 404 for unknown', async () => {
  const ok = await getMarkdownRoute(new Request('https://shots.test/docs/agents/claude.md'), {
    params: Promise.resolve({ path: ['docs', 'agents', 'claude.md'] }),
  })
  assert.equal(ok.status, 200)
  assert.match(ok.headers.get('content-type') ?? '', /^text\/markdown/)
  const body = await ok.text()
  assert.match(body, /# Shots Agent Guide for Claude/)
  assert.match(body, /createPost/)

  const missing = await getMarkdownRoute(new Request('https://shots.test/docs/agents/nope.md'), {
    params: Promise.resolve({ path: ['docs', 'agents', 'nope.md'] }),
  })
  assert.equal(missing.status, 404)
})
