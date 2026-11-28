import 'server-only'

import { AuthorizationError, getRequestId, type TenantContext } from './access'
import { apiKeyRefusal, apiKeyScopePermissions, type ApiKeyScope } from './api-key-scopes'
import type { OrganizationApiKeyPrincipal } from './principal'
import { auth } from './server'
import { isWorkspaceOperational } from '@/lib/workspace/access'

async function verifyApiKeyToContext(
  headers: Headers,
  key: string,
  scope?: ApiKeyScope
): Promise<TenantContext & { principal: OrganizationApiKeyPrincipal }> {
  const result = await auth.api.verifyApiKey({
    body: scope ? { key, permissions: apiKeyScopePermissions[scope] } : { key },
  })
  if (!result.valid || !result.key || !result.key.referenceId) {
    const { message, status } = apiKeyRefusal(result.error)
    const resolvedStatus = scope ? status : status === 429 ? 429 : 401
    throw new AuthorizationError(message, resolvedStatus)
  }
  if (!(await isWorkspaceOperational(result.key.referenceId))) {
    throw new AuthorizationError('This workspace is unavailable.', 403)
  }

  return {
    organizationId: result.key.referenceId,
    principal: {
      display: result.key.name ?? result.key.start ?? 'Organization API key',
      keyId: result.key.id,
      kind: 'organization_api_key',
      organizationId: result.key.referenceId,
    },
    requestId: getRequestId(headers),
  }
}

export async function requireOrganizationApiKeyScope(
  headers: Headers,
  scope: ApiKeyScope
): Promise<TenantContext & { principal: OrganizationApiKeyPrincipal }> {
  const key = headers.get('x-api-key')
  if (!key) {
    throw new AuthorizationError('An organization API key is required.', 401)
  }
  return verifyApiKeyToContext(headers, key, scope)
}

/**
 * Verifies any valid, enabled, non-expired workspace API key without requiring
 * a specific scope (used by `GET /api/v1/auth/me` so least-privilege keys can
 * introspect themselves). Session callers without `x-api-key` receive 403;
 * missing, invalid, disabled, or expired keys receive 401.
 */
export async function requireOrganizationApiKey(
  headers: Headers
): Promise<TenantContext & { principal: OrganizationApiKeyPrincipal }> {
  const key = headers.get('x-api-key')
  if (!key) {
    const session = await auth.api.getSession({ headers }).catch(() => null)
    if (session?.user) {
      throw new AuthorizationError(
        'This endpoint requires an organization API key in X-API-Key; browser sessions cannot call it.',
        403
      )
    }
    throw new AuthorizationError('An organization API key is required.', 401)
  }
  return verifyApiKeyToContext(headers, key)
}
