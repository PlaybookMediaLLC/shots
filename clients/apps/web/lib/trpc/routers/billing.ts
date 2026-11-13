import 'server-only'

import { TRPCError } from '@trpc/server'

import { monthlyUsagePeriod } from '@/lib/billing/display'
import { backendSDK } from '@/lib/backend/sdk'
import { includedAllowance, type WorkspaceQuota, workspacePlanSchema } from '@/lib/billing/plans'
import { workspaceSubscriptionCycle } from '@/lib/billing/stripe'
import { consumeWorkspaceQuota, WorkspaceQuotaError } from '@/lib/tenant/entitlements'
import { router } from '../init'
import { organizationProcedure } from '../procedures'

/** The workspace's plan, its usage against each monthly allowance, and its purchased credits. */
export const billingRouter = router({
  subscription: organizationProcedure('workspace:read').query(async ({ ctx }) => {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Online billing is not configured. Contact your workspace administrator for subscription details.' })
    }
    try {
      return { cycle: await workspaceSubscriptionCycle(ctx.access.organizationId) }
    } catch (cause) {
      console.error('Stripe subscription lookup failed', cause)
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'The billing provider could not be reached. Retry subscription details in a moment.', cause })
    }
  }),
  summary: organizationProcedure('workspace:read').query(async ({ ctx }) => {
    const sdk = backendSDK(ctx.access)
    const entitlements = await sdk.getEntitlements()
    const plan = workspacePlanSchema.catch(workspacePlanSchema.enum.free).parse(entitlements.plan)
    // The backend decides what the plan includes; an amount of 0 reads what is
    // left, and an exhausted allowance reads as 0.
    const allowance = async (quota: WorkspaceQuota) => ({
      included: includedAllowance(entitlements.allowances, plan, quota),
      left: await consumeWorkspaceQuota(ctx.access, quota, 0).catch((error: unknown) => {
        if (error instanceof WorkspaceQuotaError) return 0
        throw error
      }),
    })
    // The AI credit meter answers with the monthly allowance and packs together.
    const [credits, posts, emails] = await Promise.all([
      allowance('ai:credits:monthly'),
      allowance('posts:monthly'),
      allowance('emails:monthly'),
    ])
    const creditBalance = entitlements.creditBalance ?? 0
    // The grace date is in the owner's sensitive contract view, which needs a
    // fresh two-factor session; without one the page shows no date.
    const graceUntil =
      entitlements.status === 'past_due' && ctx.access.role === 'owner'
        ? await sdk
            .getWorkspaceEntitlement()
            .then(({ entitlement }) => entitlement.graceUntil)
            .catch(() => null)
        : null
    return {
      creditBalance,
      usagePeriod: monthlyUsagePeriod(),
      credits: { ...credits, left: Math.max(credits.left - creditBalance, 0) },
      emails,
      graceUntil,
      paid: entitlements.features['workspace:paid'] === true,
      posts,
      plan,
      status: entitlements.status,
    }
  }),
})
