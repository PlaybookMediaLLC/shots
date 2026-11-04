import 'server-only'

import { z } from 'zod'
import { getAuditRequestMetadata } from '@/lib/audit/request'
import { backendSDK, serviceBackend } from '@/lib/backend/sdk'
import {
  AuthorizationError,
  requireActiveOrganizationPermission,
  requireEnterpriseFeature,
  requireOrganizationPermission,
  requireSensitiveOrganizationPermission,
  type OrganizationAccess,
} from './access'
import type { Permission } from './permissions'
import { auth } from './server'

type EnterpriseFeature = 'scimEnabled' | 'ssoEnabled'

type EnterpriseAuthRequest = {
  access: OrganizationAccess
  action:
    | 'identity.scim_connection_removed'
    | 'identity.scim_token_created'
    | 'identity.sso_configured'
    | 'identity.sso_removed'
  entityType: 'scim_provider' | 'sso_provider'
}

const requestBodySchema = z.object({
  organizationId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
})

function getEnterpriseRoute(pathname: string):
  | (Omit<EnterpriseAuthRequest, 'access'> & {
      feature: EnterpriseFeature
    })
  | null {
  if (pathname === '/api/auth/scim/generate-token') {
    return {
      action: 'identity.scim_token_created',
      entityType: 'scim_provider',
      feature: 'scimEnabled',
    }
  }
  if (pathname === '/api/auth/scim/delete-provider-connection') {
    return {
      action: 'identity.scim_connection_removed',
      entityType: 'scim_provider',
      feature: 'scimEnabled',
    }
  }
  if (pathname === '/api/auth/sso/delete-provider') {
    return { action: 'identity.sso_removed', entityType: 'sso_provider', feature: 'ssoEnabled' }
  }
  if (
    [
      '/api/auth/sso/register',
      '/api/auth/sso/request-domain-verification',
      '/api/auth/sso/update-provider',
      '/api/auth/sso/verify-domain',
    ].includes(pathname)
  ) {
    return { action: 'identity.sso_configured', entityType: 'sso_provider', feature: 'ssoEnabled' }
  }

  return null
}

async function getRequestBody(request: Request): Promise<z.infer<typeof requestBodySchema>> {
  try {
    return requestBodySchema.parse(await request.clone().json())
  } catch {
    return {}
  }
}

async function getProviderOrganizationId(
  providerId: string,
  feature: EnterpriseFeature
): Promise<string | undefined> {
  const { row } = await serviceBackend().authStore({
    model: feature === 'ssoEnabled' ? 'ssoProvider' : 'scimProvider',
    op: 'findOne',
    select: ['organizationId'],
    where: [{ field: 'providerId', value: providerId }],
  })
  return typeof row?.organizationId === 'string' ? row.organizationId : undefined
}

async function getActiveOrganizationId(headers: Headers): Promise<string | undefined> {
  return (await auth.api.getSession({ headers }))?.session.activeOrganizationId ?? undefined
}

async function getOrganizationId(
  headers: Headers,
  body: z.infer<typeof requestBodySchema>,
  feature: EnterpriseFeature
): Promise<string | undefined> {
  if (body.organizationId) {
    return body.organizationId
  }
  if (body.providerId) {
    return getProviderOrganizationId(body.providerId, feature)
  }

  return getActiveOrganizationId(headers)
}

/**
 * Better Auth endpoints that change workspace state without reaching a route
 * or the backend. Their callers in the app go through tRPC, which checks these
 * same permissions; here a direct request gets the same answer, including the
 * member's permission group.
 */
const AUTH_ENDPOINT_PERMISSIONS: Readonly<Record<string, Permission>> = {
  '/api/auth/api-key/create': 'brand:manage',
  '/api/auth/api-key/delete': 'brand:manage',
  '/api/auth/api-key/update': 'brand:manage',
  '/api/auth/organization/update': 'workspace:update',
}

/** Refuses a direct request to one of those endpoints without the permission. */
export async function authorizeAuthEndpointPermission(request: Request): Promise<void> {
  const permission = AUTH_ENDPOINT_PERMISSIONS[new URL(request.url).pathname]
  if (!permission || request.method !== 'POST') return
  const { organizationId } = await getRequestBody(request)
  await (organizationId
    ? requireOrganizationPermission(request.headers, organizationId, permission)
    : requireActiveOrganizationPermission(request.headers, permission))
}

export async function authorizeEnterpriseAuthRequest(
  request: Request
): Promise<EnterpriseAuthRequest | null> {
  const route = getEnterpriseRoute(new URL(request.url).pathname)
  if (!route || request.method !== 'POST') {
    return null
  }

  const organizationId = await getOrganizationId(
    request.headers,
    await getRequestBody(request),
    route.feature
  )
  if (!organizationId) {
    throw new AuthorizationError(
      'An active organization is required for enterprise identity management.',
      403
    )
  }

  const access = await requireSensitiveOrganizationPermission(
    request.headers,
    organizationId,
    'identity:manage'
  )
  await requireEnterpriseFeature(access, route.feature)
  return { access, action: route.action, entityType: route.entityType }
}

export async function logEnterpriseAuthRequest(
  request: Request,
  enterpriseRequest: EnterpriseAuthRequest
): Promise<void> {
  await backendSDK(enterpriseRequest.access).appendAuditEvent({
    action: enterpriseRequest.action,
    entityType: enterpriseRequest.entityType,
    ...getAuditRequestMetadata(request.headers),
  })
}
