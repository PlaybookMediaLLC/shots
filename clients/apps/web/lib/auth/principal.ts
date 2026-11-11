export type SessionPrincipal = {
  /** Set when Founder Hub acts for the session; the backend checks the client's live grant. */
  client?: 'shots-founder-hub'
  display: string
  kind: 'session'
  sessionId: string
  userId: string
}

export type OrganizationApiKeyPrincipal = {
  display: string
  keyId: string
  kind: 'organization_api_key'
  organizationId: string
}

export type WebhookPrincipal = {
  connectionId: string
  kind: 'webhook'
  organizationId: string
}

export type TriggerServicePrincipal = {
  kind: 'trigger_service'
  organizationId: string
  taskRunId: string
}

export type SupportPrincipal = {
  grantId: string
  kind: 'support'
  organizationId: string
  userId: string
}

export type Principal =
  | OrganizationApiKeyPrincipal
  | SessionPrincipal
  | SupportPrincipal
  | TriggerServicePrincipal
  | WebhookPrincipal

export type AuditActor = {
  display?: string
  type: 'SERVICE' | 'SUPPORT' | 'USER' | 'WEBHOOK'
  userId?: string
}

export function getAuditActor(principal: Principal): AuditActor {
  if (principal.kind === 'session') {
    return { display: principal.display, type: 'USER', userId: principal.userId }
  }

  if (principal.kind === 'support') {
    return { type: 'SUPPORT', userId: principal.userId }
  }

  if (principal.kind === 'webhook') {
    return { display: principal.connectionId, type: 'WEBHOOK' }
  }

  if (principal.kind === 'organization_api_key') {
    return { display: principal.display, type: 'SERVICE' }
  }

  return { display: principal.taskRunId, type: 'SERVICE' }
}
