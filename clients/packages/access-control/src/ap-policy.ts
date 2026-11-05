/** Closed, versioned AP vocabulary shared by every adapter. */
export const AP_POLICY_VERSION = 1
export const AP_CAPABILITIES = [
  'invoice.read',
  'invoice.edit',
  'evidence.read',
  'evidence.export',
  'vendor.edit',
  'destination.propose',
  'destination.verify',
  'invoice.approve',
  'payment.prepare',
  'payment.release',
  'reconciliation.adjust',
  'integration.connect',
  'integration.write_enable',
  'policy.edit',
  'billing.administer',
  'support.access',
  'identity.manage',
  'credential.manage',
] as const
export type ApCapability = (typeof AP_CAPABILITIES)[number]
export const AP_READ_CAPABILITIES = ['invoice.read', 'evidence.read', 'evidence.export'] as const
export const AP_ROLE_CAPABILITIES = {
  owner: AP_CAPABILITIES,
  ap_operator: [
    ...AP_READ_CAPABILITIES,
    'invoice.edit',
    'vendor.edit',
    'destination.propose',
    'payment.prepare',
    'reconciliation.adjust',
    'integration.connect',
  ],
  approver: [...AP_READ_CAPABILITIES, 'invoice.approve', 'payment.release', 'destination.verify'],
  accountant: AP_READ_CAPABILITIES,
} as const satisfies Record<string, readonly ApCapability[]>
export type ApRole = keyof typeof AP_ROLE_CAPABILITIES
export const AP_PRINCIPAL_TYPES = ['human', 'api_key', 'service', 'agent', 'support'] as const
export type ApPrincipalType = (typeof AP_PRINCIPAL_TYPES)[number]
export const AP_STEP_UP_CAPABILITIES: readonly ApCapability[] = [
  'payment.release',
  'destination.verify',
  'policy.edit',
  'identity.manage',
  'credential.manage',
  'integration.write_enable',
  'support.access',
]
const AUTOMATION_CAPABILITIES: readonly ApCapability[] = [
  ...AP_READ_CAPABILITIES,
  'invoice.edit',
  'vendor.edit',
  'destination.propose',
  'payment.prepare',
  'reconciliation.adjust',
  'integration.connect',
]

export interface ApGrantSnapshot {
  id: string
  workspaceId: string
  entityId: string | null
  subjectId: string
  principalType: string
  personId: string
  capabilities: readonly string[]
  policyVersion: number
  startsAt: number
  expiresAt: number | null
  revokedAt: number | null
  parentId: string | null
  purpose: string | null
}

/** All fields are resolved by a trusted adapter, never deserialized from a caller's actor JSON. */
export interface ApAuthorizationInput {
  capability: string
  workspaceId: string
  entityId: string | null
  policyVersion: number
  revision: number
  expectedRevision?: number
  now: number
  principal: { type: string; subjectId: string; personId: string; purpose?: string }
  membership: { active: boolean; readOnly: boolean }
  entityExists: boolean
  grants: readonly ApGrantSnapshot[]
  grantId: string
  credentialCapabilities?: readonly string[]
  stepUpSatisfied?: boolean
  requireIndependentChecker?: boolean
  makerPersonId?: string
}

export interface ApDecision {
  outcome: 'allow' | 'deny' | 'require_step_up'
  reason: string
  policyVersion: number
  revision: number
}

export function isApCapability(value: string): value is ApCapability {
  return AP_CAPABILITIES.some((capability) => capability === value)
}

/** Pure intersection; the database adapter supplies current primary snapshots and serialization. */
export function authorizeAp(input: ApAuthorizationInput): ApDecision {
  const decision = (outcome: ApDecision['outcome'], reason: string): ApDecision => ({
    outcome,
    reason,
    policyVersion: input.policyVersion,
    revision: input.revision,
  })
  const deny = (reason: string) => decision('deny', reason)
  const { capability, principal, membership, now } = input
  if (!isApCapability(capability) || !AP_PRINCIPAL_TYPES.some((type) => type === principal.type))
    return deny('UNKNOWN_POLICY_INPUT')
  if (
    input.policyVersion !== AP_POLICY_VERSION ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    (input.expectedRevision !== undefined && input.expectedRevision !== input.revision)
  )
    return deny('STALE_AUTHORIZATION')
  if (
    !Number.isFinite(now) ||
    !membership.active ||
    !input.entityExists ||
    !input.workspaceId ||
    !principal.subjectId ||
    !principal.personId
  )
    return deny('SCOPE_DENIED')
  if (membership.readOnly && !AP_READ_CAPABILITIES.some((item) => item === capability))
    return deny('READ_ONLY')
  if (principal.type !== 'human') {
    const allowed = principal.type === 'support' ? AP_READ_CAPABILITIES : AUTOMATION_CAPABILITIES
    if (!allowed.some((item) => item === capability)) return deny('PRINCIPAL_RESTRICTED')
  }
  if (principal.type === 'api_key' && !input.credentialCapabilities?.includes(capability))
    return deny('CREDENTIAL_SCOPE_DENIED')
  if (input.credentialCapabilities && !input.credentialCapabilities.includes(capability))
    return deny('CREDENTIAL_SCOPE_DENIED')

  const byId = new Map(input.grants.map((grant) => [grant.id, grant]))
  if (byId.size !== input.grants.length) return deny('INVALID_DELEGATION')
  let grant = byId.get(input.grantId)
  if (
    !grant ||
    grant.subjectId !== principal.subjectId ||
    grant.principalType !== principal.type ||
    grant.personId !== principal.personId
  )
    return deny('GRANT_DENIED')
  if (
    (principal.type === 'service' || principal.type === 'support') &&
    (!principal.purpose || grant.purpose !== principal.purpose || grant.expiresAt === null)
  )
    return deny('PURPOSE_DENIED')
  const seen = new Set<string>()
  while (grant) {
    if (seen.has(grant.id)) return deny('INVALID_DELEGATION')
    seen.add(grant.id)
    if (
      grant.workspaceId !== input.workspaceId ||
      (grant.entityId !== null && grant.entityId !== input.entityId)
    )
      return deny('SCOPE_DENIED')
    if (
      grant.policyVersion !== AP_POLICY_VERSION ||
      grant.revokedAt !== null ||
      !Number.isFinite(grant.startsAt) ||
      grant.startsAt > now ||
      (grant.expiresAt !== null && (!Number.isFinite(grant.expiresAt) || grant.expiresAt <= now))
    )
      return deny('GRANT_INACTIVE')
    if (!grant.capabilities.every(isApCapability) || !grant.capabilities.includes(capability))
      return deny('CAPABILITY_DENIED')
    if (!grant.parentId) break
    const parent = byId.get(grant.parentId)
    if (
      !parent ||
      parent.workspaceId !== grant.workspaceId ||
      parent.personId !== grant.personId ||
      (parent.entityId !== null && parent.entityId !== grant.entityId) ||
      parent.startsAt > grant.startsAt ||
      (parent.expiresAt !== null &&
        (grant.expiresAt === null || grant.expiresAt > parent.expiresAt)) ||
      !grant.capabilities.every((item) => parent.capabilities.includes(item))
    )
      return deny('INVALID_DELEGATION')
    grant = parent
  }
  if (
    input.requireIndependentChecker &&
    (!input.makerPersonId || input.makerPersonId === principal.personId)
  )
    return deny('SEPARATION_OF_DUTIES')
  if (AP_STEP_UP_CAPABILITIES.includes(capability) && !input.stepUpSatisfied)
    return decision('require_step_up', 'STEP_UP_REQUIRED')
  return decision('allow', 'AUTHORIZED')
}
