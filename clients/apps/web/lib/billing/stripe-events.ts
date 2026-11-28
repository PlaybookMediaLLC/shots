import type Stripe from 'stripe'
import { z } from 'zod'
import type { addonSyncSchema, entitlementSyncSchema } from '@/lib/billing/entitlements'
import {
  annualMonthlyPrice,
  billingIntervalSchema,
  CREDIT_PACKS,
  type checkoutPlanSchema,
  creditPackSchema,
  PLAN_PRICES,
  WORKSPACE_ADDONS,
  type WorkspaceAddonKey,
  workspaceAddonSchema,
  workspacePlanSchema,
} from '@/lib/billing/plans'

/**
 * Pure mappings from Stripe objects to platform billing changes, kept apart
 * from the Stripe client so they can be tested without it.
 */

/** Days a past-due workspace keeps its plan while Stripe retries the card. */
const PAST_DUE_GRACE_DAYS = 14

type PlanPrices = Record<string, z.infer<typeof checkoutPlanSchema>>
type AddonPrices = Record<string, WorkspaceAddonKey>

const STANDING: Partial<Record<Stripe.Subscription.Status, number>> = {
  active: 2,
  past_due: 1,
  trialing: 2,
}

/** Whether a Stripe subscription represents a paid workspace add-on rather than a base plan. */
export function isAddonSubscription(
  subscription: Pick<Stripe.Subscription, 'items' | 'metadata'>,
  addons: AddonPrices = {}
): WorkspaceAddonKey | null {
  const fromMeta = workspaceAddonSchema.safeParse(subscription.metadata?.addon).data
  if (fromMeta) return fromMeta
  const priceId = subscription.items.data[0]?.price.id ?? ''
  return addons[priceId] ?? null
}

/**
 * The subscription that decides a workspace's plan when it has more than one:
 * a paying one over a past-due one over one that ended, then the larger plan,
 * then the newest. Add-on subscriptions (such as `x_links`) are excluded so
 * they never compete with or mask the base plan.
 */
export function governingSubscription(
  subscriptions: Stripe.Subscription[],
  plans: PlanPrices,
  addons: AddonPrices = {}
): Stripe.Subscription | null {
  const baseSubscriptions = subscriptions.filter(
    (subscription) => !isAddonSubscription(subscription, addons)
  )
  const unsold = (subscription: Stripe.Subscription) =>
    !plans[subscription.items.data[0]?.price.id ?? '']
  const effectiveStanding = (subscription: Stripe.Subscription) => {
    if (subscription.pause_collection && STANDING[subscription.status]) return 1.5
    return STANDING[subscription.status] ?? 0
  }
  const rank = (subscription: Stripe.Subscription) => {
    const plan = plans[subscription.items.data[0]?.price.id ?? '']
    return [
      effectiveStanding(subscription),
      plan ? workspacePlanSchema.options.indexOf(plan) : -1,
      subscription.created,
    ]
  }
  const sold = baseSubscriptions.filter(
    (subscription) => !unsold(subscription) && subscription.status !== 'incomplete'
  )
  const governing =
    sold.sort((a, b) => {
      const [left, right] = [rank(a), rank(b)]
      return right[0] - left[0] || right[1] - left[1] || right[2] - left[2]
    })[0] ?? null
  const liveUnsold = baseSubscriptions.some(
    (subscription) => STANDING[subscription.status] && unsold(subscription)
  )
  return governing && !STANDING[governing.status] && liveUnsold ? null : governing
}

/**
 * The governing Stripe subscription for a specific workspace add-on (e.g. `x_links`).
 */
export function governingAddonSubscription(
  subscriptions: Stripe.Subscription[],
  addons: AddonPrices,
  addonKey: WorkspaceAddonKey
): Stripe.Subscription | null {
  const matching = subscriptions.filter(
    (subscription) =>
      isAddonSubscription(subscription, addons) === addonKey && subscription.status !== 'incomplete'
  )
  const rank = (subscription: Stripe.Subscription) => [
    subscription.pause_collection && STANDING[subscription.status]
      ? 1.5
      : (STANDING[subscription.status] ?? 0),
    subscription.created,
  ]
  return (
    matching.sort((a, b) => {
      const [left, right] = [rank(a), rank(b)]
      return right[0] - left[0] || right[1] - left[1]
    })[0] ?? null
  )
}

/**
 * The entitlement a subscription grants, or null when it grants no change:
 * a first payment still pending, or a price this platform does not sell.
 * A paused subscription (`pause_collection != null`) preserves its plan name
 * with `status: 'paused'` so Billing still shows the plan and Resume CTA while
 * gating access fail-closed.
 */
export function entitlementForSubscription(
  subscription: Stripe.Subscription,
  event: { id: string; type: string },
  plans: PlanPrices
): Omit<z.input<typeof entitlementSyncSchema>, 'expectedVersion'> | null {
  const organizationId = subscription.metadata.organizationId
  const item = subscription.items.data[0]
  const plan = item ? plans[item.price.id] : undefined
  if (!organizationId || !plan || subscription.status === 'incomplete') return null
  const base = {
    eventId: event.id,
    eventType: event.type,
    externalCustomerId:
      typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id,
    externalSubscriptionId: subscription.id,
    featureOverrides: {},
    organizationId,
    provider: 'stripe',
  }
  if (subscription.pause_collection && ['active', 'trialing', 'past_due'].includes(subscription.status)) {
    return { ...base, plan, status: 'paused' }
  }
  switch (subscription.status) {
    case 'active':
      return { ...base, plan, status: 'active' }
    case 'trialing':
      return { ...base, plan, status: 'trialing' }
    case 'past_due':
      return {
        ...base,
        graceUntil: new Date((item.current_period_start + PAST_DUE_GRACE_DAYS * 86_400) * 1000),
        plan,
        status: 'past_due',
      }
    case 'paused':
      return { ...base, plan, status: 'paused' }
    default:
      // canceled, unpaid, incomplete_expired
      return { ...base, plan: workspacePlanSchema.enum.free, status: 'active' }
  }
}

/** Maps a Stripe add-on subscription into the Go backend's add-on sync payload. */
export function addonEntitlementForSubscription(
  subscription: Stripe.Subscription,
  event: { id: string; type: string },
  addons: AddonPrices
): Omit<z.input<typeof addonSyncSchema>, 'expectedVersion'> | null {
  const organizationId = subscription.metadata.organizationId
  const addonKey = isAddonSubscription(subscription, addons)
  const item = subscription.items.data[0]
  if (!organizationId || !addonKey || !item || subscription.status === 'incomplete') return null
  const toDate = (seconds: number | null | undefined) =>
    seconds ? new Date(seconds * 1000) : null
  const cancelAtPeriodEnd = Boolean(subscription.cancel_at_period_end || subscription.cancel_at)
  const effectiveEnd = subscription.cancel_at ?? item.current_period_end
  const base = {
    addonKey,
    cancelAtPeriodEnd,
    currentPeriodEnd: toDate(effectiveEnd),
    currentPeriodStart: toDate(item.current_period_start),
    eventId: event.id,
    eventType: event.type,
    externalSubscriptionId: subscription.id,
    organizationId,
    provider: 'stripe',
    quotaLimit: WORKSPACE_ADDONS[addonKey].limit,
  }
  if (subscription.pause_collection && ['active', 'trialing', 'past_due'].includes(subscription.status)) {
    return { ...base, status: 'paused' }
  }
  switch (subscription.status) {
    case 'active':
    case 'trialing':
      return { ...base, status: 'active' }
    case 'past_due':
      return {
        ...base,
        graceUntil: new Date((item.current_period_start + PAST_DUE_GRACE_DAYS * 86_400) * 1000),
        status: 'past_due',
      }
    case 'paused':
      return { ...base, status: 'paused' }
    default:
      return { ...base, cancelAtPeriodEnd: false, status: 'canceled' }
  }
}

/**
 * The AI credits a paid one-time Checkout session buys, or null when it buys
 * none: unpaid, a subscription, or no pack among its line items. A line item
 * on a price that is no longer a pack price still counts as the pack the
 * session's metadata names, so a Checkout opened before a price change grants
 * once it is paid. The session id is the grant's reference, so its completed
 * and async-succeeded events grant once between them.
 */
export function creditGrantForSession(
  session: Stripe.Checkout.Session,
  packs: Record<string, z.infer<typeof creditPackSchema>>
): { credits: number; organizationId: string; provider: string; reference: string } | null {
  const organizationId = session.client_reference_id
  if (session.mode !== 'payment' || session.payment_status !== 'paid' || !organizationId) {
    return null
  }
  const named = creditPackSchema.safeParse(session.metadata?.pack).data
  const credits = (session.line_items?.data ?? []).reduce((total, item) => {
    const pack = (item.price ? packs[item.price.id] : undefined) ?? named
    return pack ? total + CREDIT_PACKS[pack].credits * (item.quantity ?? 1) : total
  }, 0)
  return credits > 0 ? { credits, organizationId, provider: 'stripe', reference: session.id } : null
}

/** Where a buyer returning from subscription Checkout goes next. */
export const checkoutReturnSchema = z.enum(['addon_pending', 'mismatch', 'pending', 'success'])

/**
 * The outcome of a returning subscription Checkout: `mismatch` when the
 * session is unknown or tagged with another workspace, `success` once the
 * applied entitlement is a paid plan in good standing, otherwise `pending`
 * (the webhook finishes the job).
 */
export function checkoutReturnFor(
  session: Pick<Stripe.Checkout.Session, 'client_reference_id'> | null,
  organizationId: string,
  entitlement: Pick<z.input<typeof entitlementSyncSchema>, 'plan' | 'status'> | null
): z.infer<typeof checkoutReturnSchema> {
  if (!session || session.client_reference_id !== organizationId) {
    return checkoutReturnSchema.enum.mismatch
  }
  return entitlement &&
    entitlement.plan !== workspacePlanSchema.enum.free &&
    (entitlement.status === 'active' || entitlement.status === 'trialing')
    ? checkoutReturnSchema.enum.success
    : checkoutReturnSchema.enum.pending
}

/** `path` with the buyer's in-app page added as `returnTo`, when there is one. */
function withReturnTo(path: string, returnTo: string | undefined): string {
  if (!returnTo) return path
  return `${path}${path.includes('?') ? '&' : '?'}returnTo=${encodeURIComponent(returnTo)}`
}

/**
 * Where Stripe sends a subscription buyer, as app paths: the return route
 * once they pay, pricing if they cancel. Both keep the page they came from.
 */
export function checkoutRedirects(returnTo?: string): { cancel: string; success: string } {
  return {
    cancel: withReturnTo('/pricing?checkout=cancelled', returnTo),
    // Stripe fills in {CHECKOUT_SESSION_ID}, so it stays unencoded.
    success: withReturnTo('/api/billing/checkout/return?session_id={CHECKOUT_SESSION_ID}', returnTo),
  }
}

/**
 * Where a returning buyer goes: the page they were sent from, otherwise
 * `appPath` (onboarding's product step or the app). A subscription Stripe has
 * not activated yet waits on pricing, which opens the same page once it is.
 * A pending add-on Checkout returns to Billing settings with `?x_links=pending`
 * so the already-active base plan does not falsely report the add-on as enabled.
 */
export async function pathAfterCheckout(
  outcome: Exclude<z.infer<typeof checkoutReturnSchema>, 'mismatch'>,
  returnTo: string | undefined,
  appPath: () => Promise<string>
): Promise<string> {
  if (outcome === checkoutReturnSchema.enum.addon_pending) {
    return '/settings/billing?x_links=pending'
  }
  if (outcome === checkoutReturnSchema.enum.pending) {
    return withReturnTo('/pricing?checkout=pending', returnTo)
  }
  return returnTo ?? appPath()
}

/** A live subscription's billing cycle, as the billing page shows it. */
export const subscriptionCycleSchema = z.object({
  /** When a scheduled cancellation ends the plan; null when none is scheduled. */
  cancelsAt: z.string().nullable(),
  interval: billingIntervalSchema,
  /** Whether billing collection is currently paused in Stripe. */
  paused: z.boolean().default(false),
  /** The next renewal; null when the plan is paused or set to end instead. */
  renewsAt: z.string().nullable(),
  /** Scheduled automatic resume timestamp when paused with a fixed duration. */
  resumesAt: z.string().nullable().default(null),
})

/** The billing cycle of a live subscription. */
export function subscriptionCycle(subscription: {
  cancel_at: number | null
  cancel_at_period_end: boolean
  pause_collection?: { resumes_at?: number | null } | null
  items: {
    data: { current_period_end: number; price: { recurring: { interval: string } | null } }[]
  }
}): z.infer<typeof subscriptionCycleSchema> | null {
  const item = subscription.items.data[0]
  if (!item) return null
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString()
  const periodEnd = item.current_period_end ? iso(item.current_period_end) : null
  const paused = Boolean(subscription.pause_collection)
  const resumesAt = subscription.pause_collection?.resumes_at
    ? iso(subscription.pause_collection.resumes_at)
    : null
  const cancelsAt = subscription.cancel_at
    ? iso(subscription.cancel_at)
    : subscription.cancel_at_period_end
      ? periodEnd
      : null
  return {
    cancelsAt,
    interval:
      item.price.recurring?.interval === 'year'
        ? billingIntervalSchema.enum.annual
        : billingIntervalSchema.enum.monthly,
    paused,
    renewsAt: cancelsAt || paused ? null : periodEnd,
    resumesAt,
  }
}

/** Annual billing savings derived from PLAN_PRICES and ANNUAL_DISCOUNT. */
export function annualBillingOffer(plan: z.infer<typeof checkoutPlanSchema>) {
  const monthlyAnnualizedUsd = PLAN_PRICES[plan] * 12
  const annualPriceUsd = annualMonthlyPrice(plan) * 12
  const savingsUsd = monthlyAnnualizedUsd - annualPriceUsd
  return {
    annualPriceUsd,
    monthlyAnnualizedUsd,
    savingsUsd,
  }
}
