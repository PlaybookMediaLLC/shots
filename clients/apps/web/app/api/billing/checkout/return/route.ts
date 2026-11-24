import { NextResponse } from 'next/server'
import { completeCheckoutContract } from '@/lib/api/contracts/billing'
import { errorResponse, route } from '@/lib/api/route'
import { organizationAccess } from '@/lib/api/route-auth'
import { getAuthBaseUrl } from '@/lib/auth/environment'
import { completeCheckout } from '@/lib/billing/stripe'
import { checkoutReturnSchema, pathAfterCheckout } from '@/lib/billing/stripe-events'
import { pathAfterPlan } from '@/lib/onboarding/next-step'

/**
 * Stripe's success URL. Applies the plan the buyer just paid for, then sends
 * them to the in-app page they were sent to pricing from (`returnTo`), else
 * to onboarding's product step (or the app, once the workspace has a product
 * profile), or to a page that waits for the webhook when Stripe has not
 * activated the subscription yet.
 */
export const GET = route(completeCheckoutContract, {
  auth: organizationAccess('billing:manage'),
  handler: async ({ access, query }) => {
    const outcome = await completeCheckout({
      organizationId: access.organizationId,
      sessionId: query.session_id,
    })
    if (outcome === checkoutReturnSchema.enum.mismatch) {
      return errorResponse(403, 'This checkout does not belong to the active workspace.')
    }
    const next = await pathAfterCheckout(outcome, query.returnTo, async () => {
      const path = await pathAfterPlan(access)
      return `${path}${path.includes('?') ? '&' : '?'}checkout=success`
    })
    return NextResponse.redirect(new URL(next, getAuthBaseUrl()), 303)
  },
})
