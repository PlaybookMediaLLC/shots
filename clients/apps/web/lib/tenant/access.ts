import 'server-only'

import { requireActiveOrganizationAccess, type TenantContext } from '@/lib/auth/access'
import { requireOrganizationApiKeyScope } from '@/lib/auth/api-keys'
import type { TenantAccessRequirement } from '@/lib/api/access-requirements'
import { consumeWorkspaceQuota, requireWorkspaceFeatures } from '@/lib/tenant/entitlements'

export async function requireTenantAccess(
  headers: Headers,
  requirement: TenantAccessRequirement
): Promise<TenantContext> {
  // Basic workspace access precedes the operation-specific feature gate.
  const gates = (context: TenantContext) =>
    requireWorkspaceFeatures(
      context,
      requirement.feature ? ['workspace:use', requirement.feature] : ['workspace:use']
    )
  let context: TenantContext
  if (headers.has('x-api-key')) {
    context = await requireOrganizationApiKeyScope(headers, requirement.apiKeyScope)
    await gates(context)
  } else {
    context = await requireActiveOrganizationAccess(
      headers,
      requirement.permission,
      requirement.sensitive ?? false,
      gates
    )
  }
  if (requirement.quota) {
    await consumeWorkspaceQuota(context, requirement.quota)
  }

  return context
}
