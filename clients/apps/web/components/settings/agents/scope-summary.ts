import type { AgentIconId } from '@/lib/agents/mcp-clients'
import type { ApiKeyScope } from '@/lib/auth/api-key-scopes'

/** One key row returned by `apiKey.list`. */
export type WorkspaceCredential = {
  agentClient: string | null
  agentSession: {
    clientId: string
    clientName: string
    grantId: string | null
  } | null
  createdAt: Date | string
  enabled: boolean | null
  expiresAt: Date | string | null
  id: string
  lastRequest: Date | string | null
  name: string | null
  prefix: string | null
  scopes: readonly ApiKeyScope[]
  start: string | null
}

/** One OAuth client grouped across all of its active sessions in this workspace. */
export type ConnectedAgentGroup = {
  clientId: string
  clientName: string
  groupKey: string
  icon: AgentIconId
  lastActivityAt: Date
  scopes: ApiKeyScope[]
  sessions: WorkspaceCredential[]
}

/** Concise human-readable scope summary for tables and badges. */
export type ScopeSummary = {
  highTrust: boolean
  label: string
  scopes: readonly ApiKeyScope[]
  tone: 'blue' | 'gray' | 'green' | 'yellow'
}

/** Summarize granted API-key scopes honestly without claiming blanket full access. */
export function summarizeScopes(scopes: readonly ApiKeyScope[]): ScopeSummary {
  const unique = [...new Set(scopes)].sort()
  const count = unique.length
  const hasPublish = unique.includes('post:publish')
  const hasDelete = unique.includes('post:delete')
  const hasSchedule = unique.includes('post:schedule')
  const hasWrite = unique.some(
    (scope) =>
      scope === 'draft:write' ||
      scope === 'release:create' ||
      scope === 'asset:write' ||
      scope === 'upload:sign' ||
      scope === 'queue:write' ||
      scope === 'draft:comment' ||
      scope === 'source:write' ||
      scope === 'onboarding:run'
  )

  if (count === 0) {
    return { highTrust: false, label: 'No scopes', scopes: unique, tone: 'gray' }
  }
  if (hasPublish && hasDelete) {
    return {
      highTrust: true,
      label: `Publish & Delete (${count})`,
      scopes: unique,
      tone: 'yellow',
    }
  }
  if (hasPublish) {
    return {
      highTrust: true,
      label: `Direct Publishing (${count})`,
      scopes: unique,
      tone: 'yellow',
    }
  }
  if (hasDelete) {
    return {
      highTrust: true,
      label: `Post Delete (${count})`,
      scopes: unique,
      tone: 'yellow',
    }
  }
  if (hasSchedule) {
    return {
      highTrust: false,
      label: `Scheduling (${count})`,
      scopes: unique,
      tone: 'blue',
    }
  }
  if (hasWrite) {
    return {
      highTrust: false,
      label: `Read & Draft (${count})`,
      scopes: unique,
      tone: 'green',
    }
  }
  return {
    highTrust: false,
    label: count === 1 && unique[0] === 'artifact:read' ? 'Read only' : `Read (${count})`,
    scopes: unique,
    tone: 'gray',
  }
}

/** Map an OAuth client's name or identifier to its brand icon. */
export function detectAgentIcon(clientName: string, clientId = ''): AgentIconId {
  const haystack = `${clientName} ${clientId}`.toLowerCase()
  if (haystack.includes('claude')) return 'claude'
  if (haystack.includes('chatgpt')) return 'chatgpt'
  if (haystack.includes('codex')) return 'codex'
  if (haystack.includes('opencode')) return 'opencode'
  if (haystack.includes('grokbot')) return 'grokbot'
  if (haystack.includes('grok')) return 'grok'
  if (haystack.includes('openclaw')) return 'openclaw'
  if (haystack.includes('hermes')) return 'hermes'
  if (haystack.includes('cursor')) return 'cursor'
  if (haystack.includes('gemini')) return 'gemini'
  if (haystack.includes('muse')) return 'muse'
  if (haystack.includes('cli')) return 'cli'
  return 'mcp'
}

function toDate(value: Date | string | null | undefined): Date {
  if (!value) return new Date(0)
  return value instanceof Date ? value : new Date(value)
}

function activityDate(key: WorkspaceCredential): Date {
  return key.lastRequest ? toDate(key.lastRequest) : toDate(key.createdAt)
}

function isKeyExpired(key: WorkspaceCredential, nowMs: number): boolean {
  return Boolean(key.expiresAt && toDate(key.expiresAt).getTime() <= nowMs)
}

/**
 * Group active OAuth-connected agent keys by clientId (or normalized clientName
 * when clientId is absent) so multi-session clients collapse under one row.
 */
export function groupConnectedAgents(
  keys: readonly WorkspaceCredential[],
  nowMs = Date.now()
): ConnectedAgentGroup[] {
  const buckets = new Map<string, ConnectedAgentGroup>()

  for (const key of keys) {
    if (!key.agentSession || key.enabled === false || isKeyExpired(key, nowMs)) continue
    const clientName = key.agentSession.clientName.trim() || 'AI agent'
    const clientId = key.agentSession.clientId.trim()
    const groupKey = clientId ? `id:${clientId}` : `name:${clientName.toLowerCase()}`
    const currentActivity = activityDate(key)
    const existing = buckets.get(groupKey)
    if (!existing) {
      buckets.set(groupKey, {
        clientId,
        clientName,
        groupKey,
        icon: detectAgentIcon(clientName, clientId),
        lastActivityAt: currentActivity,
        scopes: [...new Set(key.scopes)].sort(),
        sessions: [key],
      })
      continue
    }
    existing.sessions.push(key)
    if (currentActivity.getTime() > existing.lastActivityAt.getTime()) {
      existing.lastActivityAt = currentActivity
    }
    existing.scopes = [...new Set([...existing.scopes, ...key.scopes])].sort()
  }

  return [...buckets.values()]
    .map((group) => ({
      ...group,
      sessions: [...group.sessions].sort(
        (a, b) => activityDate(b).getTime() - activityDate(a).getTime()
      ),
    }))
    .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
}

const credentialTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  month: 'short',
  year: 'numeric',
})

/** Format a timestamp consistently for Connected agents and API keys tables. */
export function formatCredentialTimestamp(value: Date | string | null | undefined): string {
  if (!value) return 'Never'
  const date = toDate(value)
  if (Number.isNaN(date.getTime())) return '—'
  return credentialTimestampFormatter.format(date)
}
