import { switchSubscriptionPlanContract } from '@/lib/api/contracts/billing'
import { route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { backendSDK } from '@/lib/backend/sdk'
import { updateWorkspaceSubscriptionPlan } from '@/lib/billing/stripe'

/** Workspace owners switch their plan tier or billing interval (monthly/annual). */
export const POST = route(switchSubscriptionPlanContract, {
  auth: organizationAccess('billing:manage'),
  handler: async ({ access, body }) => {
    const result = await updateWorkspaceSubscriptionPlan({
      interval: body.interval,
      organizationId: access.organizationId,
      plan: body.plan,
    })
    if (result.updated) {
      await backendSDK(access).appendAuditEvent({
        action: 'billing.interval_switched',
        entityId: access.organizationId,
        entityType: 'workspace_entitlement',
        metadata: { interval: body.interval, plan: body.plan },
        outcome: 'SUCCEEDED',
      })
    }
    return result
  },
})
