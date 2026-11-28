import { reactivateSubscriptionContract } from '@/lib/api/contracts/billing'
import { route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'
import { reactivateWorkspaceSubscription } from '@/lib/billing/stripe'

/** Workspace owners undo a scheduled cancellation before the billing period ends. */
export const POST = route(reactivateSubscriptionContract, {
  auth: organizationAccess('billing:manage'),
  handler: async ({ access }) => {
    const result = await reactivateWorkspaceSubscription({ organizationId: access.organizationId })
    await backendSDK(access).appendAuditEvent({
      action: 'billing.subscription_reactivated',
      entityId: access.organizationId,
      entityType: 'workspace_entitlement',
      metadata: {},
      outcome: 'SUCCEEDED',
    })
    return result
  },
})
