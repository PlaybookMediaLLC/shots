import { z } from 'zod'
import { apiKeyScopes } from '@/lib/auth/api-key-scopes'
import { organizationRoles, permissions } from '@/lib/auth/permissions'
import { workspaceFeatureSchema, workspaceQuotaSchema } from '@/lib/billing/plans'

/** A role permission such as `audit:read`, validated against `lib/auth/permissions`. */
export const permissionSchema = z.enum(permissions)

/** A normalized organization role, validated against `lib/auth/permissions`. */
export const organizationRoleSchema = z.enum(organizationRoles)

/** An organization API-key product scope, validated against `lib/auth/api-key-scopes`. */
export const apiKeyScopeSchema = z.enum(apiKeyScopes)

/**
 * How recent a sign-in must be. `true` is for destructive and account actions.
 * `connection` is only for connecting a social channel. It trades security for
 * fewer sign-ins: a stolen session up to 24 hours old can connect a channel.
 */
export const sensitiveAccessSchema = z.union([z.boolean(), z.literal('connection')])

/** Whether a session created at `createdAt` must sign in again for this action. */
export function isSignInTooOld(createdAt: Date, sensitive: true | 'connection', now = Date.now()) {
  // Every value but `connection` gets the strict limit.
  const minutes = sensitive === 'connection' ? 24 * 60 : 15
  return now - createdAt.getTime() > minutes * 60_000
}

/**
 * What a tenant operation requires: a session member with `permission`, or
 * an organization API key with `apiKeyScope`, then the optional plan feature
 * and metered quota. `sensitive` also requires a session to have signed in
 * recently (see {@link isSignInTooOld}) with two-factor; a key is its own
 * credential.
 */
export const tenantAccessRequirementSchema = z.object({
  apiKeyScope: apiKeyScopeSchema,
  feature: workspaceFeatureSchema.optional(),
  permission: permissionSchema,
  quota: workspaceQuotaSchema.optional(),
  sensitive: sensitiveAccessSchema.optional(),
})

/** One of {@link tenantAccessRequirementSchema}. */
export type TenantAccessRequirement = z.infer<typeof tenantAccessRequirementSchema>

/**
 * What the editor utilities (`/api/screenshot`, `/api/export`, `/api/tweet`,
 * `/api/image-proxy`) require: a member session or an `artifact:read` key, on
 * a paid plan. `requirePaidAccess` enforces it and the spec publishes it.
 */
export const editorUtilityAccess = tenantAccessRequirementSchema.parse({
  apiKeyScope: 'artifact:read',
  permission: 'workspace:read',
})

/**
 * What a human-only operation requires: a signed-in member with `permission`
 * on a paid plan, then the optional feature and quota. API keys are refused.
 * `sensitive` also requires a recent sign-in with two-factor.
 */
export const memberAccessRequirementSchema = tenantAccessRequirementSchema
  .omit({ apiKeyScope: true })
  .strict()

/** One of {@link memberAccessRequirementSchema}. */
export type MemberAccessRequirement = z.infer<typeof memberAccessRequirementSchema>

/**
 * The access a contract declares. Its route binds the matching authenticator,
 * and the OpenAPI spec publishes it as the operation's security and
 * `x-shots-entitlement`, so docs, REST, and MCP read one declaration.
 */
export const contractAccessSchema = z.union([
  tenantAccessRequirementSchema.strict(),
  memberAccessRequirementSchema,
])

/** One of {@link contractAccessSchema}. */
export type ContractAccess = z.infer<typeof contractAccessSchema>

/**
 * Which organization a permission check runs against. `active` is the
 * session's active organization. `requested` is the `organizationId` in the
 * path, query, or body, which must also be the active organization.
 */
export const organizationScopeSchema = z.enum(['active', 'requested'])

/** One of {@link organizationScopeSchema}. */
export type OrganizationScope = z.infer<typeof organizationScopeSchema>

/** Options for an organization permission check. */
export const organizationAccessOptionsSchema = z.object({
  scope: organizationScopeSchema.default('active'),
  /** Also require a sign-in under 15 minutes old with two-factor enabled. */
  sensitive: z.boolean().default(false),
})

/** Caller-facing form of {@link organizationAccessOptionsSchema}; every field is optional. */
export type OrganizationAccessOptions = z.input<typeof organizationAccessOptionsSchema>

/** The `organizationId` a `requested`-scope route names in its path, query, or body. */
export const requestedOrganizationSchema = z.object({ organizationId: z.string().min(1).max(128) })

/** One of {@link requestedOrganizationSchema}. */
export type RequestedOrganization = z.infer<typeof requestedOrganizationSchema>
