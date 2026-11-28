import { createBillingPortalContract } from '@/lib/api/contracts/billing'
import { route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { createBillingPortalSession } from '@/lib/billing/stripe'

/** Workspace owners open the Stripe Billing Portal for invoices, cards, and subscription management. */
export const POST = route(createBillingPortalContract, {
  auth: organizationAccess('billing:manage'),
  handler: async ({ access, body }) =>
    createBillingPortalSession({
      flow: body.flow,
      organizationId: access.organizationId,
      returnTo: body.returnTo,
    }),
})
