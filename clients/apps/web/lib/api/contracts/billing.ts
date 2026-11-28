import { z } from 'zod'
import { defineContract } from '@/lib/api/contract'
import { billingIntervalSchema, checkoutPlanSchema, creditPackSchema } from '@/lib/billing/plans'
import { safeReturnPath } from '@/lib/platform/navigation'

/** An in-app path such as `/publish`; another site, or anything else, is refused. */
const returnPathSchema = z
  .string()
  .max(2048)
  .refine((path) => safeReturnPath(path, '') === path, 'Must be a path in this app.')

/** Optional Stripe Billing Portal deep-link flow. */
export const billingPortalFlowSchema = z.enum([
  'payment_method_update',
  'subscription_update',
  'subscription_cancel',
])

/** Supported pause durations in months; null pauses indefinitely until resumed. */
export const pauseDurationMonthsSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.null(),
])

/** `POST /api/billing/checkout`: Stripe Checkout for a free workspace, the billing portal for a paying one. */
export const createBillingSessionContract = defineContract({
  body: z.object({
    interval: billingIntervalSchema.default('monthly'),
    plan: checkoutPlanSchema,
    returnTo: returnPathSchema
      .optional()
      .describe('The in-app page the buyer was sent from; Checkout returns there.'),
  }),
  method: 'POST',
  name: 'billing.checkout',
  output: z.object({ url: z.url() }),
  path: '/api/billing/checkout',
  summary: 'Open Stripe Checkout or the billing portal for the active workspace',
})

/** `POST /api/billing/portal`: Opens Stripe Billing Portal for payment methods, invoices, and subscription management. */
export const createBillingPortalContract = defineContract({
  body: z.object({
    flow: billingPortalFlowSchema.optional(),
    returnTo: returnPathSchema.optional(),
  }),
  method: 'POST',
  name: 'billing.portal',
  output: z.object({ url: z.url() }),
  path: '/api/billing/portal',
  summary: 'Open the Stripe Billing Portal for the active workspace',
})

/** `POST /api/billing/credits`: Stripe Checkout for a one-time AI credit pack. */
export const createCreditPackSessionContract = defineContract({
  body: z.object({ pack: creditPackSchema.default('launch') }),
  method: 'POST',
  name: 'billing.credits',
  output: z.object({ url: z.url() }),
  path: '/api/billing/credits',
  summary: 'Open Stripe Checkout for an AI credit pack for the active workspace',
})

/** `GET /api/billing/checkout/return`: where Stripe sends the buyer after a subscription Checkout. */
export const completeCheckoutContract = defineContract({
  method: 'GET',
  name: 'billing.checkout.return',
  output: z.undefined(),
  path: '/api/billing/checkout/return',
  query: z.object({
    session_id: z.string().min(1).max(255),
    // A bad value is dropped, not refused: the buyer has already paid.
    returnTo: returnPathSchema.optional().catch(undefined),
  }),
  summary: 'Apply a finished Stripe Checkout and send the buyer on',
})

/** `POST /api/billing/subscription/preview-change`: Preview prorated cost for changing plan or interval. */
export const previewSubscriptionChangeContract = defineContract({
  body: z.object({
    interval: billingIntervalSchema,
    plan: checkoutPlanSchema,
  }),
  method: 'POST',
  name: 'billing.subscription.preview-change',
  output: z.object({
    amountDueLabel: z.string(),
    amountDueMinor: z.number().int(),
    currency: z.string(),
    nextBillingDate: z.string().nullable(),
  }),
  path: '/api/billing/subscription/preview-change',
  summary: 'Preview proration for changing plan or billing interval',
})

/** `POST /api/billing/subscription/switch`: Switch the workspace base plan or billing interval in Stripe. */
export const switchSubscriptionPlanContract = defineContract({
  body: z.object({
    interval: billingIntervalSchema,
    plan: checkoutPlanSchema,
  }),
  method: 'POST',
  name: 'billing.subscription.switch',
  output: z.object({ updated: z.boolean() }),
  path: '/api/billing/subscription/switch',
  summary: 'Switch plan or billing interval for the active workspace subscription',
})

/** `POST /api/billing/subscription/pause`: Pause billing collection for the active workspace subscription. */
export const pauseSubscriptionContract = defineContract({
  body: z.object({
    resumeInMonths: pauseDurationMonthsSchema.optional().default(1),
  }),
  method: 'POST',
  name: 'billing.subscription.pause',
  output: z.object({ paused: z.boolean(), resumesAt: z.string().nullable() }),
  path: '/api/billing/subscription/pause',
  summary: 'Pause the active workspace subscription and coupled add-ons',
})

/** `POST /api/billing/subscription/resume`: Resume a paused workspace subscription. */
export const resumeSubscriptionContract = defineContract({
  body: z.object({}),
  method: 'POST',
  name: 'billing.subscription.resume',
  output: z.object({ resumed: z.boolean() }),
  path: '/api/billing/subscription/resume',
  summary: 'Resume a paused workspace subscription',
})

/** `POST /api/billing/subscription/cancel`: Schedule cancellation at period end. */
export const cancelSubscriptionContract = defineContract({
  body: z.object({
    reason: z.string().trim().max(500).optional(),
  }),
  method: 'POST',
  name: 'billing.subscription.cancel',
  output: z.object({ cancelsAt: z.string().nullable() }),
  path: '/api/billing/subscription/cancel',
  summary: 'Schedule cancellation at period end for the active workspace subscription',
})

/** `POST /api/billing/subscription/reactivate`: Undo a scheduled cancellation. */
export const reactivateSubscriptionContract = defineContract({
  body: z.object({}),
  method: 'POST',
  name: 'billing.subscription.reactivate',
  output: z.object({ reactivated: z.boolean() }),
  path: '/api/billing/subscription/reactivate',
  summary: 'Undo a scheduled cancellation for the active workspace subscription',
})

/** `POST /api/billing/addons/x-links`: Enable or reactivate the Links in X posts add-on ($10/month). */
export const enableXLinksAddonContract = defineContract({
  body: z.object({}),
  method: 'POST',
  name: 'billing.addons.x-links.enable',
  output: z.object({
    reactivated: z.boolean().optional(),
    url: z.url().optional(),
  }),
  path: '/api/billing/addons/x-links',
  summary: 'Enable or reactivate the Links in X posts add-on for the active workspace',
})

/** `DELETE /api/billing/addons/x-links`: Disable the Links in X posts add-on. */
export const disableXLinksAddonContract = defineContract({
  body: z.object({
    immediate: z.boolean().optional().default(false),
  }),
  method: 'DELETE',
  name: 'billing.addons.x-links.disable',
  output: z.object({ cancelsAt: z.string().nullable() }),
  path: '/api/billing/addons/x-links',
  summary: 'Disable the Links in X posts add-on for the active workspace',
})

/** `POST /api/billing/refund-request`: Submit an audited refund request to support. */
export const requestRefundContract = defineContract({
  body: z.object({
    invoiceId: z.string().trim().min(1).max(255).optional(),
    reason: z.string().trim().min(10).max(1000),
  }),
  method: 'POST',
  name: 'billing.refund-request',
  output: z.object({
    referenceId: z.string(),
    submitted: z.boolean(),
  }),
  path: '/api/billing/refund-request',
  summary: 'Submit an audited refund request for the active workspace',
})
