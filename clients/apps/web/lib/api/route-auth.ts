import 'server-only'

import {
  type MemberAccessRequirement,
  memberAccessRequirementSchema,
  type OrganizationAccessOptions,
  organizationAccessOptionsSchema,
  organizationScopeSchema,
  requestedOrganizationSchema,
  type TenantAccessRequirement,
} from '@/lib/api/access-requirements'
import { hasMaintenanceAccess } from '@/lib/api/maintenance-auth'
import { headersWithNavigationScope } from '@/lib/auth/request-scope'
import { platformHeaders } from '@/lib/api/request-context'
import type { Authenticate, RawRequest } from '@/lib/api/route'
import {
  AuthorizationError,
  type OrganizationAccess,
  requireActiveOrganizationAccess,
  requireActiveOrganizationPermission,
  requireOrganizationPermission,
  requireSensitiveActiveOrganizationPermission,
  requireSensitiveOrganizationPermission,
  requireSessionAccess,
  type SessionAccess,
  type TenantContext,
} from '@/lib/auth/access'
import type { Permission } from '@/lib/auth/permissions'
import { requireTenantAccess } from '@/lib/tenant/access'
import {
  consumeWorkspaceQuota,
  requireWorkspaceFeature,
  requireWorkspaceFeatures,
} from '@/lib/tenant/entitlements'

/**
 * Authenticators for `route()`. Each resolves the caller or throws an
 * `AuthorizationError`, and runs before any input is validated.
 */

/**
 * No caller identity. A route that authenticates with a signed token or an
 * HMAC signature uses its own authenticator instead.
 */
export const publicAccess: Authenticate<null> = async () => null

/** The shared maintenance secret, for operator-only endpoints. */
export const maintenanceAccess: Authenticate<null> = async ({ request }) => {
  if (!hasMaintenanceAccess(request)) {
    throw new AuthorizationError('Maintenance access is required.', 401)
  }
  return null
}

/** Any signed-in user, with or without an active organization. */
export const sessionAccess: Authenticate<SessionAccess> = async ({ request }) =>
  requireSessionAccess(request.headers)

/** The `organizationId` from the path, then the query, then the body. */
function getRequestedOrganizationId({ body, params, query }: RawRequest): string {
  for (const source of [params, query]) {
    const parsed = requestedOrganizationSchema.safeParse(source)
    if (parsed.success) return parsed.data.organizationId
  }
  return requestedOrganizationSchema.parse(body).organizationId
}

/** A signed-in organization member whose role grants `permission`. */
export function organizationAccess(
  permission: Permission,
  options: OrganizationAccessOptions = {}
): Authenticate<OrganizationAccess> {
  const { scope, sensitive } = organizationAccessOptionsSchema.parse(options)
  if (scope === organizationScopeSchema.enum.active) {
    const requireActive = sensitive
      ? requireSensitiveActiveOrganizationPermission
      : requireActiveOrganizationPermission
    return async ({ request }) => requireActive(request.headers, permission)
  }
  const requireRequested = sensitive
    ? requireSensitiveOrganizationPermission
    : requireOrganizationPermission
  return async ({ raw, request }) =>
    requireRequested(request.headers, getRequestedOrganizationId(await raw()), permission)
}

/**
 * {@link organizationAccess} for a route a browser reaches by following a link,
 * which can't send the workspace scope as headers and carries it in the query.
 */
export function navigationOrganizationAccess(
  permission: Permission
): Authenticate<OrganizationAccess> {
  return async ({ request }) =>
    requireActiveOrganizationPermission(headersWithNavigationScope(request), permission)
}

/**
 * A session member with `requirement.permission`, or an organization API key
 * with `requirement.apiKeyScope`, then the optional plan feature and quota.
 * `sensitive` also requires the session's fresh second factor.
 */
export function tenantAccess(requirement: TenantAccessRequirement): Authenticate<TenantContext> {
  return async ({ request }) => requireTenantAccess(request.headers, requirement)
}

/**
 * A signed-in member of the active workspace with `requirement.permission`,
 * on a paid plan, then the optional feature and quota. An API key is refused
 * with 403 before the session is read: approving and publishing are a
 * person's decisions (RFC 012, RFC 030). `sensitive` also requires a fresh
 * second factor.
 */
export function memberAccess(
  requirement: MemberAccessRequirement
): Authenticate<OrganizationAccess> {
  const { feature, permission, quota, sensitive } = memberAccessRequirementSchema.parse(requirement)
  return async ({ request }) => {
    if (request.headers.has(platformHeaders['x-api-key'])) {
      throw new AuthorizationError(
        'A signed-in workspace member must do this; API keys cannot.',
        403
      )
    }
    // Basic workspace access precedes the operation-specific feature gate.
    const access = await requireActiveOrganizationAccess(
      request.headers,
      permission,
      Boolean(sensitive),
      (context) =>
        requireWorkspaceFeatures(context, feature ? ['workspace:use', feature] : ['workspace:use'])
    )
    if (quota) await consumeWorkspaceQuota(access, quota)
    return access
  }
}

/**
 * A signed-in member of the active workspace with `permission`, on a paid
 * plan. API keys are refused: store publishing and its credentials are
 * human actions. `sensitive` also requires a fresh second factor.
 */
export function paidSessionAccess(
  permission: Permission,
  options: { sensitive?: boolean } = {}
): Authenticate<OrganizationAccess> {
  return async ({ request }) => {
    return requireActiveOrganizationAccess(
      request.headers,
      permission,
      Boolean(options.sensitive),
      (context) => requireWorkspaceFeature(context, 'workspace:paid')
    )
  }
}
