import 'server-only'

import Stripe from 'stripe'
import { BackendSDKError } from 'screenshot-studio-backend-sdk'
import { z } from 'zod'
import { getAuthBaseUrl } from '@/lib/auth/environment'
import {
  addonSyncSchema,
  entitlementSyncSchema,
  grantWorkspaceCredits,
  syncWorkspaceAddon,
  syncWorkspaceEntitlement,
} from '@/lib/billing/entitlements'
import {
  type billingIntervalSchema,
  checkoutPlanSchema,
  type creditPackSchema,
  type WorkspaceAddonKey,
  workspaceAddonSchema,
  workspacePlanSchema,
} from '@/lib/billing/plans'
import {
  addonEntitlementForSubscription,
  annualBillingOffer,
  checkoutRedirects,
  checkoutReturnFor,
  checkoutReturnSchema,
  creditGrantForSession,
  entitlementForSubscription,
  governingAddonSubscription,
  governingSubscription,
  isAddonSubscription,
  subscriptionCycle,
} from '@/lib/billing/stripe-events'
import { formatMinorCurrency, subscriptionBaseCharge } from './display'

/**
 * Self-serve billing through Stripe. Checkout starts a subscription tagged
 * with the workspace; Stripe's subscription events then sync the plan and any
 * workspace add-ons (such as `x_links`) through versioned entitlement updates.
 * One-time credit packs are granted when their Checkout session is paid.
 */

const stripeEnvironmentSchema = z.object({
  STRIPE_PRICE_BUSINESS_ANNUAL: z.string().min(1).optional(),
  STRIPE_PRICE_BUSINESS_MONTHLY: z.string().min(1).optional(),
  STRIPE_PRICE_EXTRA_LAUNCH: z.string().min(1).optional(),
  STRIPE_PRICE_PRO_ANNUAL: z.string().min(1).optional(),
  STRIPE_PRICE_PRO_MONTHLY: z.string().min(1).optional(),
  STRIPE_PRICE_X_LINKS_MONTHLY: z.string().min(1).optional(),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
})

function stripeEnvironment() {
  return stripeEnvironmentSchema.parse({
    STRIPE_PRICE_BUSINESS_ANNUAL: process.env.STRIPE_PRICE_BUSINESS_ANNUAL || undefined,
    STRIPE_PRICE_BUSINESS_MONTHLY: process.env.STRIPE_PRICE_BUSINESS_MONTHLY || undefined,
    STRIPE_PRICE_EXTRA_LAUNCH: process.env.STRIPE_PRICE_EXTRA_LAUNCH || undefined,
    STRIPE_PRICE_PRO_ANNUAL: process.env.STRIPE_PRICE_PRO_ANNUAL || undefined,
    STRIPE_PRICE_PRO_MONTHLY: process.env.STRIPE_PRICE_PRO_MONTHLY || undefined,
    STRIPE_PRICE_X_LINKS_MONTHLY: process.env.STRIPE_PRICE_X_LINKS_MONTHLY || undefined,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY || undefined,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET || undefined,
  })
}

function priceIds(): Record<string, z.infer<typeof checkoutPlanSchema>> {
  const env = stripeEnvironment()
  const entries = [
    [env.STRIPE_PRICE_PRO_MONTHLY, 'pro'],
    [env.STRIPE_PRICE_PRO_ANNUAL, 'pro'],
    [env.STRIPE_PRICE_BUSINESS_MONTHLY, 'business'],
    [env.STRIPE_PRICE_BUSINESS_ANNUAL, 'business'],
  ] as const
  return Object.fromEntries(entries.filter(([price]) => price))
}

function addonPriceIds(): Record<string, WorkspaceAddonKey> {
  const price = stripeEnvironment().STRIPE_PRICE_X_LINKS_MONTHLY
  return price ? { [price]: workspaceAddonSchema.enum.x_links } : {}
}

function planPriceId(
  plan: z.infer<typeof checkoutPlanSchema>,
  interval: z.infer<typeof billingIntervalSchema>
): string | undefined {
  const env = stripeEnvironment()
  if (plan === 'pro') {
    return interval === 'annual' ? env.STRIPE_PRICE_PRO_ANNUAL : env.STRIPE_PRICE_PRO_MONTHLY
  }
  return interval === 'annual'
    ? env.STRIPE_PRICE_BUSINESS_ANNUAL
    : env.STRIPE_PRICE_BUSINESS_MONTHLY
}

function packPrices(): Record<string, z.infer<typeof creditPackSchema>> {
  const price = stripeEnvironment().STRIPE_PRICE_EXTRA_LAUNCH
  return price ? { [price]: 'launch' } : {}
}

let client: Stripe | null = null

function stripe(): Stripe | null {
  const key = stripeEnvironment().STRIPE_SECRET_KEY
  if (!key) return null
  client ??= new Stripe(key)
  return client
}

/** A billing request the platform cannot serve; the message is written for the owner. */
export class BillingError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 503
  ) {
    super(message)
    this.name = 'BillingError'
  }
}

const quoted = (value: string) => `'${value.replace(/['\\]/g, '\\$&')}'`

/** Every Stripe subscription tagged with the workspace, any status. */
async function workspaceSubscriptions(api: Stripe, organizationId: string) {
  const { data } = await api.subscriptions.search({
    limit: 100,
    query: `metadata['organizationId']:${quoted(organizationId)}`,
  })
  return data.filter((subscription) => subscription.metadata?.organizationId === organizationId)
}

function mapStripeError(error: unknown, fallback: string): never {
  if (error instanceof BillingError) throw error
  if (error instanceof Stripe.errors.StripeCardError) {
    throw new BillingError(error.message || 'Your card was declined. Update your payment method and try again.', 400)
  }
  if (error instanceof Stripe.errors.StripeInvalidRequestError) {
    throw new BillingError(error.message || fallback, 409)
  }
  if (
    error instanceof Stripe.errors.StripeConnectionError ||
    error instanceof Stripe.errors.StripeAPIError ||
    error instanceof Stripe.errors.StripeRateLimitError
  ) {
    throw new BillingError('Stripe could not be reached right now. Please try again in a moment.', 503)
  }
  throw error
}

function customerIdOf(subscription: Pick<Stripe.Subscription, 'customer'>): string {
  return typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer.id
}

const LIVE_STRIPE_STATUSES = new Set(['active', 'past_due', 'paused', 'trialing'])

function liveBaseSubscription(subscriptions: Stripe.Subscription[]): Stripe.Subscription | null {
  const governing = governingSubscription(subscriptions, priceIds(), addonPriceIds())
  return governing && LIVE_STRIPE_STATUSES.has(governing.status) ? governing : null
}

function liveAddonSubscription(
  subscriptions: Stripe.Subscription[],
  addonKey: WorkspaceAddonKey
): Stripe.Subscription | null {
  const governing = governingAddonSubscription(subscriptions, addonPriceIds(), addonKey)
  return governing && LIVE_STRIPE_STATUSES.has(governing.status) ? governing : null
}

function allLiveAddonSubscriptions(
  subscriptions: Stripe.Subscription[],
  addonKey: WorkspaceAddonKey
): Stripe.Subscription[] {
  const addons = addonPriceIds()
  return subscriptions.filter(
    (subscription) =>
      isAddonSubscription(subscription, addons) === addonKey &&
      LIVE_STRIPE_STATUSES.has(subscription.status)
  )
}

const appUrl = (path: string) => `${getAuthBaseUrl()}${path}`
const returnUrl = () => appUrl('/settings/billing')

let portalConfiguration: Promise<string> | null = null

/**
 * The Shots billing portal, created on first use and found again by its
 * metadata. The Stripe account also bills other products, so the account's
 * default portal is never used: it could offer their plans to Shots
 * customers, or Shots plans to theirs.
 */
function shotsPortal(api: Stripe): Promise<string> {
  // ponytail: replicas starting together may each create one; any of them works.
  // Delete the configuration in Stripe to rebuild it after the price list changes.
  portalConfiguration ??= (async () => {
    const { data } = await api.billingPortal.configurations.list({ active: true, limit: 100 })
    const existing = data.find((configuration) => configuration.metadata?.app === 'shots')
    if (existing) return existing.id
    const products = new Map<string, string[]>()
    for (const price of await Promise.all(
      Object.keys(priceIds()).map((id) => api.prices.retrieve(id))
    )) {
      const product = typeof price.product === 'string' ? price.product : price.product.id
      products.set(product, [...(products.get(product) ?? []), price.id])
    }
    const created = await api.billingPortal.configurations.create({
      business_profile: {
        headline: 'Manage your Shots plan',
        privacy_policy_url: `${getAuthBaseUrl()}/privacy-policy`,
        terms_of_service_url: `${getAuthBaseUrl()}/terms`,
      },
      default_return_url: returnUrl(),
      features: {
        customer_update: { allowed_updates: ['email', 'address', 'tax_id'], enabled: true },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: 'at_period_end' },
        subscription_update: {
          default_allowed_updates: ['price'],
          enabled: true,
          products: [...products].map(([product, prices]) => ({ prices, product })),
          proration_behavior: 'create_prorations',
        },
      },
      metadata: { app: 'shots' },
    })
    return created.id
  })().catch((error: unknown) => {
    portalConfiguration = null
    throw error
  })
  return portalConfiguration
}

/**
 * Opens Stripe's Billing Portal for the workspace, optionally deep-linking into
 * payment-method update, plan update, or cancellation flows.
 */
export async function createBillingPortalSession(input: {
  flow?: 'payment_method_update' | 'subscription_cancel' | 'subscription_update'
  organizationId: string
  returnTo?: string
}): Promise<{ url: string }> {
  const api = stripe()
  if (!api) {
    throw new BillingError('Online billing is not configured yet. Contact us for assistance.', 503)
  }
  const subscriptions = await workspaceSubscriptions(api, input.organizationId)
  const liveBase = liveBaseSubscription(subscriptions)
  const customerSub = liveBase ?? subscriptions[0] ?? null
  if (!customerSub) {
    throw new BillingError('No online Stripe subscription is linked to this workspace.', 409)
  }
  if ((input.flow === 'subscription_update' || input.flow === 'subscription_cancel') && !liveBase) {
    throw new BillingError('No active online base plan subscription found for this workspace.', 409)
  }
  const targetReturn = input.returnTo ? appUrl(input.returnTo) : returnUrl()
  const flowData: Stripe.BillingPortal.SessionCreateParams.FlowData | undefined =
    input.flow === 'payment_method_update'
      ? { type: 'payment_method_update' }
      : input.flow === 'subscription_update' && liveBase
        ? { subscription_update: { subscription: liveBase.id }, type: 'subscription_update' }
        : input.flow === 'subscription_cancel' && liveBase
          ? { subscription_cancel: { subscription: liveBase.id }, type: 'subscription_cancel' }
          : undefined
  try {
    const portal = await api.billingPortal.sessions.create({
      configuration: await shotsPortal(api),
      customer: customerIdOf(customerSub),
      ...(flowData ? { flow_data: flowData } : {}),
      return_url: targetReturn,
    })
    return { url: portal.url }
  } catch (error) {
    mapStripeError(error, 'Could not open the Stripe Billing Portal right now.')
  }
}

/**
 * Where to send an admin who wants to pay: the billing portal when the
 * workspace already has a live subscription, Checkout when it has none, so a
 * workspace does not end up with two. A paid plan without a Stripe
 * subscription is invoiced and changes through sales.
 */
export async function createBillingSession(input: {
  currentPlan: string
  interval: z.infer<typeof billingIntervalSchema>
  organizationId: string
  plan: z.infer<typeof checkoutPlanSchema>
  /** The in-app page the buyer was sent from; Checkout and the portal return there. */
  returnTo?: string
}): Promise<{ url: string }> {
  const api = stripe()
  const price = planPriceId(input.plan, input.interval)
  if (!api || !price) {
    throw new BillingError('Self-serve checkout is not available yet. Contact us to upgrade.', 503)
  }
  const live = liveBaseSubscription(await workspaceSubscriptions(api, input.organizationId))
  if (live) {
    const portal = await api.billingPortal.sessions.create({
      configuration: await shotsPortal(api),
      customer: customerIdOf(live),
      return_url: input.returnTo ? appUrl(input.returnTo) : returnUrl(),
    })
    return { url: portal.url }
  }
  if (input.currentPlan !== workspacePlanSchema.enum.free) {
    throw new BillingError(
      'This workspace is billed by invoice. Contact us to change its plan.',
      409
    )
  }

  // Stripe Tax adds sales tax from the address Checkout collects. Stripe refuses the
  // session until Tax is activated (head office address) in the Dashboard.
  const redirects = checkoutRedirects(input.returnTo)
  const session = await api.checkout.sessions.create({
    allow_promotion_codes: true,
    automatic_tax: { enabled: true },
    cancel_url: appUrl(redirects.cancel),
    client_reference_id: input.organizationId,
    line_items: [{ price, quantity: 1 }],
    mode: 'subscription',
    subscription_data: { metadata: { organizationId: input.organizationId } },
    success_url: appUrl(redirects.success),
  })
  if (!session.url) throw new Error('Stripe returned a Checkout session without a URL.')
  return { url: session.url }
}

/**
 * The live subscription's interval, renewal, pause/cancel state, base amount,
 * and annual upgrade offer, or null without Stripe or a live base subscription.
 */
export async function workspaceSubscriptionCycle(organizationId: string) {
  return (await workspaceSubscriptionOverview(organizationId)).cycle
}

/**
 * Returns the live base subscription cycle alongside whether the workspace has
 * any Stripe customer/subscription (so Enterprise workspaces with a Stripe
 * `x_links` add-on can still open Billing Portal and list invoices).
 */
export async function workspaceSubscriptionOverview(organizationId: string) {
  const api = stripe()
  if (!api) return { cycle: null, hasStripeCustomer: false }
  const all = await workspaceSubscriptions(api, organizationId)
  const hasStripeCustomer = all.length > 0
  const live = liveBaseSubscription(all)
  if (!live) return { cycle: null, hasStripeCustomer }
  const cycle = subscriptionCycle(live)
  if (!cycle) return { cycle: null, hasStripeCustomer }
  const charge = subscriptionBaseCharge(live.items.data)
  const plans = priceIds()
  const currentPlan = plans[live.items.data[0]?.price.id ?? '']
  const parsedPlan = checkoutPlanSchema.safeParse(currentPlan).data
  const annualOffer =
    parsedPlan && cycle.interval === 'monthly' && !cycle.cancelsAt && !cycle.paused
      ? annualBillingOffer(parsedPlan)
      : null
  return {
    cycle: {
      ...cycle,
      amountLabel: charge?.amountLabel ?? null,
      amountMinor: charge?.amountMinor ?? null,
      annualOffer,
      currency: charge?.currency ?? null,
      priceLabel: charge?.priceLabel ?? null,
    },
    hasStripeCustomer,
  }
}

/** Lists recent paid invoices for the workspace's Stripe customer (for Request Refund). */
export async function workspaceRecentInvoices(organizationId: string) {
  const api = stripe()
  if (!api) return []
  const subscriptions = await workspaceSubscriptions(api, organizationId)
  const anySub = liveBaseSubscription(subscriptions) ?? subscriptions[0]
  if (!anySub) return []
  const { data } = await api.invoices.list({
    customer: customerIdOf(anySub),
    limit: 5,
    status: 'paid',
  })
  return data.map((invoice) => ({
    amountPaidLabel: formatMinorCurrency(invoice.amount_paid, invoice.currency),
    createdAt: new Date(invoice.created * 1000).toISOString(),
    id: invoice.id,
    number: invoice.number ?? null,
  }))
}

/** Previews switching the live subscription to another plan or billing interval. */
export async function previewSubscriptionChange(input: {
  interval: z.infer<typeof billingIntervalSchema>
  organizationId: string
  plan: z.infer<typeof checkoutPlanSchema>
}) {
  const api = stripe()
  const price = planPriceId(input.plan, input.interval)
  if (!api || !price) {
    throw new BillingError('Online plan switching is not available right now.', 503)
  }
  const live = liveBaseSubscription(await workspaceSubscriptions(api, input.organizationId))
  const item = live?.items.data[0]
  if (!live || !item) {
    throw new BillingError('No active online subscription found for this workspace.', 409)
  }
  if (live.pause_collection || live.status === 'paused') {
    throw new BillingError('Resume your subscription before switching plans.', 409)
  }
  if (item.price.id === price) {
    throw new BillingError('This workspace is already on that plan and billing interval.', 409)
  }
  try {
    const preview = await api.invoices.createPreview({
      customer: customerIdOf(live),
      subscription: live.id,
      subscription_details: {
        items: [{ id: item.id, price }],
        proration_behavior: 'create_prorations',
      },
    })
    return {
      amountDueLabel: formatMinorCurrency(preview.amount_due, preview.currency),
      amountDueMinor: preview.amount_due,
      currency: preview.currency,
      nextBillingDate: preview.next_payment_attempt
        ? new Date(preview.next_payment_attempt * 1000).toISOString()
        : null,
    }
  } catch (error) {
    mapStripeError(error, 'Could not preview this plan change right now.')
  }
}

/** Switches the live base subscription's plan and/or billing interval in Stripe and syncs Go. */
export async function updateWorkspaceSubscriptionPlan(input: {
  interval: z.infer<typeof billingIntervalSchema>
  organizationId: string
  plan: z.infer<typeof checkoutPlanSchema>
}) {
  const api = stripe()
  const price = planPriceId(input.plan, input.interval)
  if (!api || !price) {
    throw new BillingError('Online plan switching is not available right now.', 503)
  }
  const all = await workspaceSubscriptions(api, input.organizationId)
  const live = liveBaseSubscription(all)
  const item = live?.items.data[0]
  if (!live || !item) {
    throw new BillingError('No active online subscription found for this workspace.', 409)
  }
  if (live.pause_collection || live.status === 'paused') {
    throw new BillingError('Resume your subscription before switching plans.', 409)
  }
  if (item.price.id === price) {
    return { updated: false }
  }
  let updated: Stripe.Subscription
  try {
    updated = await api.subscriptions.update(live.id, {
      cancel_at: null,
      cancel_at_period_end: false,
      items: [{ id: item.id, price }],
      payment_behavior: 'error_if_incomplete',
      proration_behavior: 'create_prorations',
    })
  } catch (error) {
    mapStripeError(
      error,
      'Could not charge your payment method for this plan switch. Update your payment method in the Stripe Billing Portal and try again.'
    )
  }
  if (updated.pending_update || updated.items.data[0]?.price.id !== price) {
    throw new BillingError(
      'Payment confirmation is required to complete this plan change. Update or confirm your payment method in the Stripe Billing Portal.',
      409
    )
  }
  await syncSubscription(
    api,
    updated,
    { id: `plan_switch_${updated.id}_${Date.now()}`, type: 'customer.subscription.updated' },
    all
  )
  return { updated: true }
}

/** Pauses billing collection on any coupled active add-on first, then on the base subscription. */
export async function pauseWorkspaceSubscription(input: {
  organizationId: string
  resumeInMonths?: 1 | 2 | 3 | null
}) {
  const api = stripe()
  if (!api) {
    throw new BillingError('Online billing is not configured yet.', 503)
  }
  const all = await workspaceSubscriptions(api, input.organizationId)
  const live = liveBaseSubscription(all)
  if (!live) {
    throw new BillingError('No active online subscription found to pause.', 409)
  }
  const resumesAt = input.resumeInMonths
    ? Math.floor(Date.now() / 1000) + input.resumeInMonths * 30 * 86_400
    : undefined
  const pauseConfig: Stripe.SubscriptionUpdateParams.PauseCollection = {
    behavior: 'void',
    ...(resumesAt ? { resumes_at: resumesAt } : {}),
  }
  const stamp = Date.now()
  try {
    // Pause coupled add-ons BEFORE pausing the base plan so a failure leaves the base plan retryable.
    for (const xLinks of allLiveAddonSubscriptions(all, workspaceAddonSchema.enum.x_links)) {
      if (!xLinks.pause_collection) {
        const pausedAddon = await api.subscriptions.update(xLinks.id, {
          pause_collection: pauseConfig,
        })
        await syncAddonSubscription(
          api,
          pausedAddon,
          { id: `pause_addon_${pausedAddon.id}_${stamp}`, type: 'customer.subscription.paused' },
          all
        )
      }
    }
    const paused = await api.subscriptions.update(live.id, { pause_collection: pauseConfig })
    await syncSubscription(
      api,
      paused,
      { id: `pause_${paused.id}_${stamp}`, type: 'customer.subscription.paused' },
      all
    )
  } catch (error) {
    mapStripeError(error, 'Could not pause this subscription right now.')
  }
  return { paused: true, resumesAt: resumesAt ? new Date(resumesAt * 1000).toISOString() : null }
}

/** Resumes a paused base subscription (and any paused coupled add-on). */
export async function resumeWorkspaceSubscription(input: { organizationId: string }) {
  const api = stripe()
  if (!api) {
    throw new BillingError('Online billing is not configured yet.', 503)
  }
  const all = await workspaceSubscriptions(api, input.organizationId)
  const live = liveBaseSubscription(all)
  if (!live || (!live.pause_collection && live.status !== 'paused')) {
    throw new BillingError('No paused online subscription found to resume.', 409)
  }
  const stamp = Date.now()
  try {
    const resumed =
      live.status === 'paused'
        ? await api.subscriptions.resume(live.id)
        : await api.subscriptions.update(live.id, { pause_collection: '' })
    await syncSubscription(
      api,
      resumed,
      { id: `resume_${resumed.id}_${stamp}`, type: 'customer.subscription.resumed' },
      all
    )
    for (const xLinks of allLiveAddonSubscriptions(all, workspaceAddonSchema.enum.x_links)) {
      if (xLinks.pause_collection || xLinks.status === 'paused') {
        const resumedAddon =
          xLinks.status === 'paused'
            ? await api.subscriptions.resume(xLinks.id)
            : await api.subscriptions.update(xLinks.id, { pause_collection: '' })
        await syncAddonSubscription(
          api,
          resumedAddon,
          { id: `resume_addon_${resumedAddon.id}_${stamp}`, type: 'customer.subscription.resumed' },
          all
        )
      }
    }
  } catch (error) {
    mapStripeError(error, 'Could not resume this subscription right now.')
  }
  return { resumed: true }
}

/** Schedules cancellation at period end for any active add-on first, then the base plan. */
export async function cancelWorkspaceSubscription(input: {
  organizationId: string
  reason?: string
}) {
  const api = stripe()
  if (!api) {
    throw new BillingError('Online billing is not configured yet.', 503)
  }
  const all = await workspaceSubscriptions(api, input.organizationId)
  const live = liveBaseSubscription(all)
  if (!live) {
    throw new BillingError('No active online subscription found to cancel.', 409)
  }
  const stamp = Date.now()
  const baseEnd = live.items.data[0]?.current_period_end
  try {
    // Schedule coupled add-on cancellation first without extending an already-earlier cancellation.
    for (const xLinks of allLiveAddonSubscriptions(all, workspaceAddonSchema.enum.x_links)) {
      const existingCancelAt = xLinks.cancel_at ?? (xLinks.cancel_at_period_end ? xLinks.items.data[0]?.current_period_end : null)
      const needsUpdate = !existingCancelAt || (baseEnd && baseEnd < existingCancelAt)
      if (needsUpdate) {
        const updatedAddon = await api.subscriptions.update(
          xLinks.id,
          baseEnd ? { cancel_at: baseEnd } : { cancel_at_period_end: true }
        )
        await syncAddonSubscription(
          api,
          updatedAddon,
          { id: `cancel_addon_${updatedAddon.id}_${stamp}`, type: 'customer.subscription.updated' },
          all
        )
      }
    }
    const updated = await api.subscriptions.update(live.id, {
      cancel_at_period_end: true,
      ...(input.reason
        ? { cancellation_details: { comment: input.reason.slice(0, 500) } }
        : {}),
    })
    await syncSubscription(
      api,
      updated,
      { id: `cancel_${updated.id}_${stamp}`, type: 'customer.subscription.updated' },
      all
    )
    const cycle = subscriptionCycle(updated)
    return { cancelsAt: cycle?.cancelsAt ?? null }
  } catch (error) {
    mapStripeError(error, 'Could not schedule cancellation right now.')
  }
}

/** Undoes a scheduled cancellation on the base subscription and coupled canceling add-ons. */
export async function reactivateWorkspaceSubscription(input: { organizationId: string }) {
  const api = stripe()
  if (!api) {
    throw new BillingError('Online billing is not configured yet.', 503)
  }
  const all = await workspaceSubscriptions(api, input.organizationId)
  const live = liveBaseSubscription(all)
  if (!live) {
    throw new BillingError('No online subscription found to reactivate.', 409)
  }
  const baseCancelAt = live.cancel_at ?? live.items.data[0]?.current_period_end ?? null
  const stamp = Date.now()
  try {
    const updated = await api.subscriptions.update(live.id, {
      cancel_at: null,
      cancel_at_period_end: false,
    })
    await syncSubscription(
      api,
      updated,
      { id: `reactivate_${updated.id}_${stamp}`, type: 'customer.subscription.updated' },
      all
    )
    for (const xLinks of allLiveAddonSubscriptions(all, workspaceAddonSchema.enum.x_links)) {
      if (xLinks.cancel_at && baseCancelAt && xLinks.cancel_at === baseCancelAt) {
        const reactivatedAddon = await api.subscriptions.update(xLinks.id, {
          cancel_at: null,
          cancel_at_period_end: false,
        })
        await syncAddonSubscription(
          api,
          reactivatedAddon,
          {
            id: `reactivate_addon_${reactivatedAddon.id}_${stamp}`,
            type: 'customer.subscription.updated',
          },
          all
        )
      }
    }
  } catch (error) {
    mapStripeError(error, 'Could not reactivate this subscription right now.')
  }
  return { reactivated: true }
}

/**
 * Turns on the Links in X posts add-on ($10/month). If already active and
 * scheduled to cancel or paused, reactivates/resumes in place; otherwise starts
 * a Stripe Checkout session on the workspace's existing Stripe customer.
 */
export async function enableXLinksAddon(input: {
  organizationId: string
}): Promise<{ reactivated?: boolean; url?: string }> {
  const api = stripe()
  const price = stripeEnvironment().STRIPE_PRICE_X_LINKS_MONTHLY
  if (!api || !price) {
    throw new BillingError(
      'The Links in X posts add-on is not configured yet. Contact us to enable it.',
      503
    )
  }
  const all = await workspaceSubscriptions(api, input.organizationId)
  const existing = liveAddonSubscription(all, workspaceAddonSchema.enum.x_links)
  if (existing) {
    if (existing.status === 'past_due') {
      throw new BillingError(
        'Update your payment method in the Stripe Billing Portal to restore Links in X posts.',
        409
      )
    }
    try {
      const updated =
        existing.status === 'paused'
          ? await api.subscriptions.resume(existing.id)
          : existing.cancel_at_period_end || existing.cancel_at || existing.pause_collection
            ? await api.subscriptions.update(existing.id, {
                cancel_at: null,
                cancel_at_period_end: false,
                ...(existing.pause_collection ? { pause_collection: '' } : {}),
              })
            : existing
      await syncAddonSubscription(
        api,
        updated,
        { id: `addon_reactivate_${updated.id}_${Date.now()}`, type: 'customer.subscription.updated' },
        all
      )
      return { reactivated: true }
    } catch (error) {
      mapStripeError(error, 'Could not reactivate Links in X posts right now.')
    }
  }
  const base = liveBaseSubscription(all)
  const customer = base ? customerIdOf(base) : undefined
  try {
    const session = await api.checkout.sessions.create({
      automatic_tax: { enabled: true },
      cancel_url: `${returnUrl()}?x_links=cancelled`,
      client_reference_id: input.organizationId,
      ...(customer ? { customer, customer_update: { address: 'auto' } } : {}),
      line_items: [{ price, quantity: 1 }],
      metadata: { addon: workspaceAddonSchema.enum.x_links, organizationId: input.organizationId },
      mode: 'subscription',
      subscription_data: {
        metadata: { addon: workspaceAddonSchema.enum.x_links, organizationId: input.organizationId },
      },
      success_url: `${appUrl('/api/billing/checkout/return')}?session_id={CHECKOUT_SESSION_ID}&returnTo=${encodeURIComponent('/settings/billing?x_links=enabled')}`,
    })
    if (!session.url) throw new Error('Stripe returned a Checkout session without a URL.')
    return { url: session.url }
  } catch (error) {
    mapStripeError(error, 'Could not start checkout for Links in X posts right now.')
  }
}

/** Turns off the Links in X posts add-on at period end (or immediately when requested). */
export async function disableXLinksAddon(input: {
  immediate?: boolean
  organizationId: string
}): Promise<{ cancelsAt: string | null }> {
  const api = stripe()
  if (!api) {
    throw new BillingError('Online billing is not configured yet.', 503)
  }
  const all = await workspaceSubscriptions(api, input.organizationId)
  const existing = liveAddonSubscription(all, workspaceAddonSchema.enum.x_links)
  if (!existing) {
    throw new BillingError('Links in X posts is not currently active on this workspace.', 409)
  }
  const stamp = Date.now()
  try {
    const updated = input.immediate
      ? await api.subscriptions.cancel(existing.id)
      : await api.subscriptions.update(existing.id, { cancel_at_period_end: true })
    await syncAddonSubscription(
      api,
      updated,
      {
        id: `addon_disable_${updated.id}_${stamp}`,
        type: input.immediate ? 'customer.subscription.deleted' : 'customer.subscription.updated',
      },
      all
    )
    const cycle = subscriptionCycle(updated)
    return { cancelsAt: input.immediate ? null : (cycle?.cancelsAt ?? null) }
  } catch (error) {
    mapStripeError(error, 'Could not turn off Links in X posts right now.')
  }
}

/** Verifies a paid invoice belongs to the workspace's Stripe customer before attaching it to a refund ticket. */
export async function verifyWorkspaceInvoice(organizationId: string, invoiceId: string) {
  const api = stripe()
  if (!api) return null
  const subscriptions = await workspaceSubscriptions(api, organizationId)
  const customerIds = new Set(subscriptions.map(customerIdOf))
  if (customerIds.size === 0) return null
  let invoice: Stripe.Invoice | null
  try {
    invoice = await api.invoices.retrieve(invoiceId)
  } catch (error) {
    if (error instanceof Stripe.errors.StripeInvalidRequestError) return null
    throw new BillingError('Could not verify the invoice right now. Please try again.', 503)
  }
  if (!invoice || invoice.status !== 'paid') return null
  const invCustomer = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id
  if (!invCustomer || !customerIds.has(invCustomer)) return null
  return {
    amountPaidLabel: formatMinorCurrency(invoice.amount_paid, invoice.currency),
    createdAt: new Date(invoice.created * 1000).toISOString(),
    id: invoice.id,
    number: invoice.number ?? null,
  }
}

/** Opens Checkout for a one-time AI credit pack, on any plan. */
export async function createCreditPackSession(input: {
  organizationId: string
  pack: z.infer<typeof creditPackSchema>
}): Promise<{ url: string }> {
  const api = stripe()
  const price = Object.entries(packPrices()).find(([, pack]) => pack === input.pack)?.[0]
  if (!api || !price) {
    throw new BillingError('Credit packs are not available yet. Contact us to add credits.', 503)
  }
  const session = await api.checkout.sessions.create({
    automatic_tax: { enabled: true },
    cancel_url: `${returnUrl()}?credits=cancelled`,
    client_reference_id: input.organizationId,
    line_items: [{ price, quantity: 1 }],
    metadata: { organizationId: input.organizationId, pack: input.pack },
    mode: 'payment',
    success_url: `${returnUrl()}?credits=success`,
  })
  if (!session.url) throw new Error('Stripe returned a Checkout session without a URL.')
  return { url: session.url }
}

const PAYMENT_EVENTS = new Set([
  'checkout.session.async_payment_succeeded',
  'checkout.session.completed',
])

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'customer.subscription.updated',
])

/** Verifies a Stripe webhook body against its signature header. */
export function verifyStripeEvent(body: string, signature: string | null): Stripe.Event | null {
  const api = stripe()
  const secret = stripeEnvironment().STRIPE_WEBHOOK_SECRET
  if (!api || !secret || !signature) return null
  try {
    return api.webhooks.constructEvent(body, signature, secret)
  } catch {
    return null
  }
}

/**
 * Applies a Stripe event. A paid credit pack is granted once per Checkout
 * session. A subscription change routes add-on subscriptions to the add-on
 * sync and base subscriptions to the workspace entitlement sync (cascading
 * cancellation/pause to active add-ons when the base plan ends or pauses).
 */
export async function syncStripeEvent(event: Stripe.Event): Promise<{ synced: boolean }> {
  const api = stripe()
  if (!api) return { synced: false }
  if (PAYMENT_EVENTS.has(event.type)) {
    const { id } = event.data.object as Stripe.Checkout.Session
    const session = await api.checkout.sessions.retrieve(id, { expand: ['line_items'] })
    const grant = creditGrantForSession(session, packPrices())
    if (!grant) return { synced: false }
    await grantWorkspaceCredits(grant)
    return { synced: true }
  }
  if (!SUBSCRIPTION_EVENTS.has(event.type)) return { synced: false }
  const { id } = event.data.object as Stripe.Subscription
  const retrieved = await api.subscriptions.retrieve(id)
  const organizationId = retrieved.metadata.organizationId
  const siblings = organizationId ? await workspaceSubscriptions(api, organizationId) : []
  if (isAddonSubscription(retrieved, addonPriceIds())) {
    const synced = await syncAddonSubscription(api, retrieved, event, siblings)
    return { synced: synced !== null }
  }
  const entitlement = await syncSubscription(api, retrieved, event, siblings)
  if (entitlement && entitlement.plan === workspacePlanSchema.enum.free) {
    // Base plan ended: cancel every live x_links add-on so the workspace is never orphaned on $10/mo.
    for (const xLinks of allLiveAddonSubscriptions(siblings, workspaceAddonSchema.enum.x_links)) {
      let canceled: Stripe.Subscription | null = null
      try {
        canceled = await api.subscriptions.cancel(xLinks.id)
      } catch (error) {
        if (error instanceof Stripe.errors.StripeInvalidRequestError) {
          canceled = await api.subscriptions.retrieve(xLinks.id)
        } else {
          // Propagate transient Stripe errors so the webhook retries instead of leaving an orphan charge.
          throw error
        }
      }
      if (canceled) {
        await syncAddonSubscription(
          api,
          canceled,
          { id: `${event.id}:cascade_addon:${xLinks.id}`, type: 'customer.subscription.deleted' },
          siblings
        )
      }
    }
  } else if (entitlement && entitlement.status === 'paused' && retrieved.pause_collection) {
    // Base plan paused externally: cascade pause to any unpaused live x_links add-on.
    for (const xLinks of allLiveAddonSubscriptions(siblings, workspaceAddonSchema.enum.x_links)) {
      if (!xLinks.pause_collection) {
        const pausedAddon = await api.subscriptions.update(xLinks.id, {
          pause_collection: {
            behavior: retrieved.pause_collection.behavior,
            ...(retrieved.pause_collection.resumes_at
              ? { resumes_at: retrieved.pause_collection.resumes_at }
              : {}),
          },
        })
        await syncAddonSubscription(
          api,
          pausedAddon,
          { id: `${event.id}:cascade_pause:${xLinks.id}`, type: 'customer.subscription.paused' },
          siblings
        )
      }
    }
  }
  return { synced: entitlement !== null }
}

async function withVersionRetry<T>(run: (expectedVersion: number) => Promise<T>): Promise<T> {
  let expectedVersion = 0
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run(expectedVersion)
    } catch (error) {
      const current = error instanceof BackendSDKError ? error.details.currentVersion : undefined
      if (
        error instanceof BackendSDKError &&
        error.status === 409 &&
        typeof current === 'number' &&
        attempt < 2
      ) {
        expectedVersion = current
        continue
      }
      throw error
    }
  }
}

/**
 * Re-reads every subscription the workspace has and applies the plan of the
 * one that governs, so events delivered out of order, or a second
 * subscription ending, still leave the right plan. A stale entitlement
 * version is retried with the one the backend reports. Returns what was
 * applied, or null when the subscriptions grant no change.
 */
async function syncSubscription(
  api: Stripe,
  changed: Stripe.Subscription,
  event: { id: string; type: string },
  preloadedSiblings?: Stripe.Subscription[]
) {
  const organizationId = changed.metadata.organizationId
  const siblings =
    preloadedSiblings ?? (organizationId ? await workspaceSubscriptions(api, organizationId) : [])
  const plans = priceIds()
  const addons = addonPriceIds()
  const governing = governingSubscription(
    [changed, ...siblings.filter((subscription) => subscription.id !== changed.id)],
    plans,
    addons
  )
  const entitlement = governing && entitlementForSubscription(governing, event, plans)
  if (!entitlement) return null
  await withVersionRetry((expectedVersion) =>
    syncWorkspaceEntitlement(entitlementSyncSchema.parse({ ...entitlement, expectedVersion }))
  )
  return entitlement
}

async function syncAddonSubscription(
  api: Stripe,
  changed: Stripe.Subscription,
  event: { id: string; type: string },
  preloadedSiblings?: Stripe.Subscription[]
) {
  const organizationId = changed.metadata.organizationId
  const addons = addonPriceIds()
  const addonKey = isAddonSubscription(changed, addons)
  if (!organizationId || !addonKey) return null
  const siblings = preloadedSiblings ?? (await workspaceSubscriptions(api, organizationId))
  const governing = governingAddonSubscription(
    [changed, ...siblings.filter((subscription) => subscription.id !== changed.id)],
    addons,
    addonKey
  )
  const payload = governing && addonEntitlementForSubscription(governing, event, addons)
  if (!payload) return null
  await withVersionRetry((expectedVersion) =>
    syncWorkspaceAddon(addonSyncSchema.parse({ ...payload, expectedVersion }))
  )
  return payload
}

/**
 * Applies a finished subscription Checkout (base plan or add-on) as soon as the
 * buyer returns, without waiting for the webhook, through the same sync the
 * webhook runs.
 */
export async function completeCheckout(input: {
  organizationId: string
  sessionId: string
}): Promise<z.infer<typeof checkoutReturnSchema>> {
  const api = stripe()
  if (!api) return checkoutReturnSchema.enum.pending
  const session = await api.checkout.sessions
    .retrieve(input.sessionId, { expand: ['subscription'] })
    .catch((error: unknown) => {
      if (error instanceof Stripe.errors.StripeInvalidRequestError) return null
      throw error
    })
  const subscription =
    session?.status === 'complete' &&
    session.client_reference_id === input.organizationId &&
    session.subscription &&
    typeof session.subscription !== 'string'
      ? session.subscription
      : null
  const isAddonSession =
    Boolean(session?.metadata?.addon) ||
    Boolean(subscription && isAddonSubscription(subscription, addonPriceIds()))
  if (session && session.client_reference_id === input.organizationId && isAddonSession) {
    if (!subscription) return checkoutReturnSchema.enum.addon_pending
    const synced = await syncAddonSubscription(api, subscription, {
      id: session.id,
      type: 'checkout.session.completed',
    })
    return synced && synced.status === 'active'
      ? checkoutReturnSchema.enum.success
      : checkoutReturnSchema.enum.addon_pending
  }
  const entitlement =
    session && subscription
      ? await syncSubscription(api, subscription, {
          id: session.id,
          type: 'checkout.session.completed',
        })
      : null
  return checkoutReturnFor(session, input.organizationId, entitlement)
}
