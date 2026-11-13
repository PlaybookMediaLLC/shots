import type { AuditActor } from '@/lib/auth/principal'
import type { AuditMetadata } from './metadata'

export type AuditOutcome = 'SUCCEEDED' | 'FAILED' | 'DENIED'

export const auditActions = [
  'audience.unsubscribed',
  'audit.drain_created',
  'audit.drain_deleted',
  'audit.log_exported',
  'audit.log_read',
  'audit.retention_changed',
  'auth.session_revoked',
  'billing.entitlement_changed',
  'communication.cancelled',
  'communication.delivered',
  'communication.delivery_recovery_required',
  'communication.partially_failed',
  'communication.scheduled',
  'identity.scim_token_created',
  'identity.scim_connection_removed',
  'identity.sso_configured',
  'identity.sso_removed',
  'post.cancelled',
  'post.connection_created',
  'post.publish_failed',
  'post.accepted_by_scheduler',
  'post.publish_recovery_required',
  'post.published',
  'post.scheduled',
  'post.sent_to_app',
  'support.access_granted',
  'support.access_revoked',
] as const

export type AuditAction = (typeof auditActions)[number] | `product.${string}`

export type AuditLogInput = {
  action: AuditAction
  actor: AuditActor
  entityId?: string
  entityType: string
  ipHash?: string
  metadata?: AuditMetadata
  organizationId: string
  outcome?: AuditOutcome
  requestId: string
  userAgentSummary?: string
}
