import { cancelSubscriptionContract } from '@/lib/api/contracts/billing'
import { route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'
import { cancelWorkspaceSubscription } from '@/lib/billing/stripe'

/** Workspace owners schedule subscription cancellation at the end of the current period. */
export const POST = route(cancelSubscriptionContract, {
  auth: organizationAccess('billing:manage'),
  handler: async ({ access, body }) => {
    const result = await cancelWorkspaceSubscription({
      organizationId: access.organizationId,
      reason: body.reason,
    })
    await backendSDK(access).appendAuditEvent({
      action: 'billing.subscription_cancel_scheduled',
      entityId: access.organizationId,
      entityType: 'workspace_entitlement',
      metadata: { cancelsAt: result.cancelsAt, hasReason: Boolean(body.reason) },
      outcome: 'SUCCEEDED',
    })
    return result
  },
})
