import { resumeSubscriptionContract } from '@/lib/api/contracts/billing'
import { route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'
import { resumeWorkspaceSubscription } from '@/lib/billing/stripe'

/** Workspace owners resume a paused subscription and coupled add-ons. */
export const POST = route(resumeSubscriptionContract, {
  auth: organizationAccess('billing:manage'),
  handler: async ({ access }) => {
    const result = await resumeWorkspaceSubscription({ organizationId: access.organizationId })
    await backendSDK(access).appendAuditEvent({
      action: 'billing.subscription_resumed',
      entityId: access.organizationId,
      entityType: 'workspace_entitlement',
      metadata: {},
      outcome: 'SUCCEEDED',
    })
    return result
  },
})
