import 'server-only'

import { subscriptionPriceLabel } from './display'

import Stripe from 'stripe'
import { BackendSDKError } from 'screenshot-studio-backend-sdk'
import { z } from 'zod'
import { getAuthBaseUrl } from '@/lib/auth/environment'
import {
  entitlementSyncSchema,
  grantWorkspaceCredits,
  syncWorkspaceEntitlement,
} from '@/lib/billing/entitlements'
import {
  type billingIntervalSchema,
  type checkoutPlanSchema,
  type creditPackSchema,
  workspacePlanSchema,
} from '@/lib/billing/plans'
import {
  checkoutRedirects,
  checkoutReturnFor,
  checkoutReturnSchema,
  creditGrantForSession,
  entitlementForSubscription,
  governingSubscription,
  subscriptionCycle,
} from '@/lib/billing/stripe-events'

/**
 * Self-serve billing through Stripe. Checkout starts a subscription tagged
 * with the workspace; Stripe's subscription events then sync the plan through
 * the same versioned entitlement update the signed billing webhook uses.
 * One-time credit packs are granted when their Checkout session is paid.
 */

const stripeEnvironmentSchema = z.object({
  STRIPE_PRICE_BUSINESS_ANNUAL: z.string().min(1).optional(),
  STRIPE_PRICE_BUSINESS_MONTHLY: z.string().min(1).optional(),
  STRIPE_PRICE_EXTRA_LAUNCH: z.string().min(1).optional(),
  STRIPE_PRICE_PRO_ANNUAL: z.string().min(1).optional(),
  STRIPE_PRICE_PRO_MONTHLY: z.string().min(1).optional(),
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
    readonly status: 409 | 503
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
  return data
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
  const env = stripeEnvironment()
  const price =
    input.plan === 'pro'
      ? input.interval === 'annual'
        ? env.STRIPE_PRICE_PRO_ANNUAL
        : env.STRIPE_PRICE_PRO_MONTHLY
      : input.interval === 'annual'
        ? env.STRIPE_PRICE_BUSINESS_ANNUAL
        : env.STRIPE_PRICE_BUSINESS_MONTHLY
  if (!api || !price) {
    throw new BillingError('Self-serve checkout is not available yet. Contact us to upgrade.', 503)
  }
  const live = (await workspaceSubscriptions(api, input.organizationId)).find((subscription) =>
    ['active', 'past_due', 'trialing'].includes(subscription.status)
  )
  if (live) {
    const portal = await api.billingPortal.sessions.create({
      configuration: await shotsPortal(api),
      customer: typeof live.customer === 'string' ? live.customer : live.customer.id,
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
 * The live subscription's interval, renewal and scheduled cancellation, or
 * null without Stripe or a live subscription: an invoiced plan's terms are in
 * its contract.
 */
export async function workspaceSubscriptionCycle(organizationId: string) {
  const api = stripe()
  if (!api) return null
  const live = (await workspaceSubscriptions(api, organizationId)).find((subscription) =>
    ['active', 'past_due', 'trialing'].includes(subscription.status)
  )
  if (!live) return null
  const cycle = subscriptionCycle(live)
  return cycle ? { ...cycle, priceLabel: subscriptionPriceLabel(live.items.data) } : null
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
 * session. A subscription change re-reads every subscription the workspace
 * has, so events delivered out of order, or a second subscription ending,
 * still leave the plan of the one that governs; a stale entitlement version
 * is retried with the one the backend reports.
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
  const entitlement = await syncSubscription(api, await api.subscriptions.retrieve(id), event)
  return { synced: entitlement !== null }
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
  event: { id: string; type: string }
) {
  const organizationId = changed.metadata.organizationId
  const siblings = organizationId ? await workspaceSubscriptions(api, organizationId) : []
  const plans = priceIds()
  const governing = governingSubscription(
    [changed, ...siblings.filter((subscription) => subscription.id !== changed.id)],
    plans
  )
  const entitlement = governing && entitlementForSubscription(governing, event, plans)
  if (!entitlement) return null
  let expectedVersion = 0
  for (let attempt = 0; ; attempt += 1) {
    try {
      await syncWorkspaceEntitlement(
        entitlementSyncSchema.parse({ ...entitlement, expectedVersion })
      )
      return entitlement
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
 * Applies a finished subscription Checkout as soon as the buyer returns,
 * without waiting for the webhook, through the same sync the webhook runs.
 * The session id is the event id, so a reload replays instead of reapplying.
 * A session that belongs to another workspace, or one Stripe does not know,
 * is refused.
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
  const entitlement =
    session && subscription
      ? await syncSubscription(api, subscription, {
          id: session.id,
          type: 'checkout.session.completed',
        })
      : null
  return checkoutReturnFor(session, input.organizationId, entitlement)
}
