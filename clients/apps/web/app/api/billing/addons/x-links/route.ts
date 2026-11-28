import { disableXLinksAddonContract, enableXLinksAddonContract } from '@/lib/api/contracts/billing'
import { errorResponse, route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'
import { disableXLinksAddon, enableXLinksAddon } from '@/lib/billing/stripe'
import { requireWorkspaceFeature, WorkspaceEntitlementError } from '@/lib/tenant/entitlements'

/** Workspace owners on a paid plan enable or reactivate the Links in X posts add-on ($10/month). */
export const POST = route(enableXLinksAddonContract, {
  auth: organizationAccess('billing:manage'),
  handler: async ({ access }) => {
    try {
      await requireWorkspaceFeature(access, 'workspace:paid')
    } catch (error) {
      if (!(error instanceof WorkspaceEntitlementError)) throw error
      return errorResponse(403, 'Subscribe to a plan before turning on Links in X posts.', {
        code: 'workspace_feature_not_entitled',
      })
    }
    const result = await enableXLinksAddon({ organizationId: access.organizationId })
    await backendSDK(access).appendAuditEvent({
      action: 'billing.addon_enable_requested',
      entityId: access.organizationId,
      entityType: 'workspace_addon',
      metadata: { addonKey: 'x_links', reactivated: Boolean(result.reactivated) },
      outcome: 'SUCCEEDED',
    })
    return result
  },
})

/** Workspace owners disable the Links in X posts add-on (at period end by default). */
export const DELETE = route(disableXLinksAddonContract, {
  auth: organizationAccess('billing:manage'),
  handler: async ({ access, body }) => {
    const result = await disableXLinksAddon({
      immediate: body.immediate,
      organizationId: access.organizationId,
    })
    await backendSDK(access).appendAuditEvent({
      action: 'billing.addon_disable_requested',
      entityId: access.organizationId,
      entityType: 'workspace_addon',
      metadata: {
        addonKey: 'x_links',
        cancelsAt: result.cancelsAt,
        immediate: Boolean(body.immediate),
      },
      outcome: 'SUCCEEDED',
    })
    return result
  },
})
