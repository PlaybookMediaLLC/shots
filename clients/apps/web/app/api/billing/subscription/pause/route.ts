import { pauseSubscriptionContract } from '@/lib/api/contracts/billing'
import { route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'
import { pauseWorkspaceSubscription } from '@/lib/billing/stripe'

/** Workspace owners pause billing collection on their subscription and coupled add-ons. */
export const POST = route(pauseSubscriptionContract, {
  auth: organizationAccess('billing:manage'),
  handler: async ({ access, body }) => {
    const result = await pauseWorkspaceSubscription({
      organizationId: access.organizationId,
      resumeInMonths: body.resumeInMonths,
    })
    await backendSDK(access).appendAuditEvent({
      action: 'billing.subscription_paused',
      entityId: access.organizationId,
      entityType: 'workspace_entitlement',
      metadata: { resumeInMonths: body.resumeInMonths ?? null, resumesAt: result.resumesAt },
      outcome: 'SUCCEEDED',
    })
    return result
  },
})
