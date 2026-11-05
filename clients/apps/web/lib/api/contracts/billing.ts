import { z } from 'zod'
import { defineContract } from '@/lib/api/contract'
import { billingIntervalSchema, checkoutPlanSchema, creditPackSchema } from '@/lib/billing/plans'
import { safeReturnPath } from '@/lib/platform/navigation'

/** An in-app path such as `/publish`; another site, or anything else, is refused. */
const returnPathSchema = z
  .string()
  .max(2048)
  .refine((path) => safeReturnPath(path, '') === path, 'Must be a path in this app.')

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
