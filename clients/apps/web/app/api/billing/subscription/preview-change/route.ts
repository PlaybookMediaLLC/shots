import { previewSubscriptionChangeContract } from '@/lib/api/contracts/billing'
import { route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { previewSubscriptionChange } from '@/lib/billing/stripe'

/** Workspace owners preview the prorated charge for switching plan or billing interval. */
export const POST = route(previewSubscriptionChangeContract, {
  auth: organizationAccess('billing:manage'),
  handler: async ({ access, body }) =>
    previewSubscriptionChange({
      interval: body.interval,
      organizationId: access.organizationId,
      plan: body.plan,
    }),
})
