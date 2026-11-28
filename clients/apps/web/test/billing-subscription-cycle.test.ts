import assert from 'node:assert/strict'
import test from 'node:test'
import type Stripe from 'stripe'
import {
  addonEntitlementForSubscription,
  annualBillingOffer,
  entitlementForSubscription,
  governingAddonSubscription,
  governingSubscription,
  pathAfterCheckout,
  subscriptionCycle,
} from '@/lib/billing/stripe-events'

const at = (iso: string) => Date.parse(iso) / 1000
const subscription = (
  interval: string,
  options: {
    cancel_at?: number
    cancel_at_period_end?: boolean
    pause_collection?: { resumes_at?: number | null } | null
  } = {}
) => ({
  cancel_at: options.cancel_at ?? null,
  cancel_at_period_end: options.cancel_at_period_end ?? false,
  items: {
    data: [{ current_period_end: at('2026-11-20T00:00:00Z'), price: { recurring: { interval } } }],
  },
  pause_collection: options.pause_collection ?? null,
})

const stripeSub = (overrides: Record<string, unknown>) =>
  ({
    cancel_at: null,
    cancel_at_period_end: false,
    created: 1,
    customer: 'cus_1',
    id: 'sub_1',
    items: {
      data: [
        {
          current_period_end: at('2026-12-27T00:00:00Z'),
          current_period_start: at('2026-11-27T00:00:00Z'),
          price: { id: 'price_pro' },
        },
      ],
    },
    metadata: { organizationId: 'org_1' },
    pause_collection: null,
    status: 'active',
    ...overrides,
  }) as unknown as Stripe.Subscription

test('a live subscription renews at the end of its period', () => {
  assert.deepEqual(subscriptionCycle(subscription('month')), {
    cancelsAt: null,
    interval: 'monthly',
    paused: false,
    renewsAt: '2026-11-20T00:00:00.000Z',
    resumesAt: null,
  })
  assert.equal(subscriptionCycle(subscription('year'))?.interval, 'annual')
})

test('a cancelled subscription ends instead of renewing', () => {
  assert.deepEqual(subscriptionCycle(subscription('month', { cancel_at_period_end: true })), {
    cancelsAt: '2026-11-20T00:00:00.000Z',
    interval: 'monthly',
    paused: false,
    renewsAt: null,
    resumesAt: null,
  })
  assert.equal(
    subscriptionCycle(subscription('year', { cancel_at: at('2026-12-01T00:00:00Z') }))?.cancelsAt,
    '2026-12-01T00:00:00.000Z'
  )
  assert.equal(
    subscriptionCycle({ cancel_at: null, cancel_at_period_end: false, items: { data: [] } }),
    null
  )
})

test('a paused subscription reports paused with optional resumesAt and maps entitlement to paused', () => {
  const pausedCycle = subscriptionCycle(
    subscription('month', { pause_collection: { resumes_at: at('2027-01-15T00:00:00Z') } })
  )
  assert.deepEqual(pausedCycle, {
    cancelsAt: null,
    interval: 'monthly',
    paused: true,
    renewsAt: null,
    resumesAt: '2027-01-15T00:00:00.000Z',
  })

  const plans = { price_pro: 'pro' } as const
  const ent = entitlementForSubscription(
    stripeSub({ pause_collection: { behavior: 'void' }, status: 'active' }),
    { id: 'evt_pause', type: 'customer.subscription.paused' },
    plans
  )
  assert.equal(ent?.plan, 'pro')
  assert.equal(ent?.status, 'paused')
})

test('add-on subscriptions are partitioned from base plans and sync independently', () => {
  const plans = { price_business: 'business', price_pro: 'pro' } as const
  const addons = { price_x_links: 'x_links' } as const
  const base = stripeSub({
    id: 'sub_base',
    items: {
      data: [
        {
          current_period_end: at('2026-12-27T00:00:00Z'),
          current_period_start: at('2026-11-27T00:00:00Z'),
          price: { id: 'price_pro' },
        },
      ],
    },
  })
  const addon = stripeSub({
    id: 'sub_addon',
    items: {
      data: [
        {
          current_period_end: at('2026-12-27T00:00:00Z'),
          current_period_start: at('2026-11-27T00:00:00Z'),
          price: { id: 'price_x_links' },
        },
      ],
    },
    metadata: { addon: 'x_links', organizationId: 'org_1' },
  })

  assert.equal(governingSubscription([addon, base], plans, addons)?.id, 'sub_base')
  assert.equal(governingAddonSubscription([base, addon], addons, 'x_links')?.id, 'sub_addon')

  const synced = addonEntitlementForSubscription(
    addon,
    { id: 'evt_addon', type: 'customer.subscription.created' },
    addons
  )
  assert.equal(synced?.addonKey, 'x_links')
  assert.equal(synced?.status, 'active')
  assert.equal(synced?.quotaLimit, 40)
  assert.equal(synced?.cancelAtPeriodEnd, false)

  const canceled = addonEntitlementForSubscription(
    stripeSub({
      ...addon,
      status: 'canceled',
    }),
    { id: 'evt_addon_end', type: 'customer.subscription.deleted' },
    addons
  )
  assert.equal(canceled?.status, 'canceled')
})

test('annualBillingOffer derives savings from PLAN_PRICES and ANNUAL_DISCOUNT', () => {
  assert.deepEqual(annualBillingOffer('pro'), {
    annualPriceUsd: 300,
    monthlyAnnualizedUsd: 348,
    savingsUsd: 48,
  })
  assert.deepEqual(annualBillingOffer('business'), {
    annualPriceUsd: 804,
    monthlyAnnualizedUsd: 948,
    savingsUsd: 144,
  })
})

test('a canceled subscription with retained pause_collection never outranks a live past_due subscription', () => {
  const plans = { price_pro: 'pro' } as const
  const addons = { price_x_links: 'x_links' } as const

  const canceledPausedBase = stripeSub({
    created: at('2026-10-01T00:00:00Z'),
    id: 'sub_canceled_paused',
    pause_collection: { behavior: 'void' },
    status: 'canceled',
  })
  const livePastDueBase = stripeSub({
    created: at('2026-11-01T00:00:00Z'),
    id: 'sub_past_due',
    status: 'past_due',
  })
  assert.equal(
    governingSubscription([canceledPausedBase, livePastDueBase], plans, addons)?.id,
    'sub_past_due'
  )

  const canceledPausedAddon = stripeSub({
    created: at('2026-10-01T00:00:00Z'),
    id: 'sub_addon_canceled_paused',
    items: {
      data: [
        {
          current_period_end: at('2026-12-27T00:00:00Z'),
          current_period_start: at('2026-11-27T00:00:00Z'),
          price: { id: 'price_x_links' },
        },
      ],
    },
    metadata: { addon: 'x_links', organizationId: 'org_1' },
    pause_collection: { behavior: 'void' },
    status: 'canceled',
  })
  const livePastDueAddon = stripeSub({
    created: at('2026-11-01T00:00:00Z'),
    id: 'sub_addon_past_due',
    items: canceledPausedAddon.items,
    metadata: { addon: 'x_links', organizationId: 'org_1' },
    status: 'past_due',
  })
  assert.equal(
    governingAddonSubscription([canceledPausedAddon, livePastDueAddon], addons, 'x_links')?.id,
    'sub_addon_past_due'
  )
})

test('addonEntitlementForSubscription maps cancel_at, paused, past_due grace, and incomplete', () => {
  const addons = { price_x_links: 'x_links' } as const
  const addonBase = {
    items: {
      data: [
        {
          current_period_end: at('2026-12-27T00:00:00Z'),
          current_period_start: at('2026-11-27T00:00:00Z'),
          price: { id: 'price_x_links' },
        },
      ],
    },
    metadata: { addon: 'x_links', organizationId: 'org_1' },
  }

  const coupledCancel = addonEntitlementForSubscription(
    stripeSub({ ...addonBase, cancel_at: at('2027-06-15T00:00:00Z'), status: 'active' }),
    { id: 'evt_cancel_at', type: 'customer.subscription.updated' },
    addons
  )
  assert.equal(coupledCancel?.cancelAtPeriodEnd, true)
  assert.ok(coupledCancel?.currentPeriodEnd instanceof Date)
  assert.equal(coupledCancel.currentPeriodEnd.toISOString(), '2027-06-15T00:00:00.000Z')

  const paused = addonEntitlementForSubscription(
    stripeSub({ ...addonBase, pause_collection: { behavior: 'void' }, status: 'active' }),
    { id: 'evt_paused', type: 'customer.subscription.paused' },
    addons
  )
  assert.equal(paused?.status, 'paused')

  const pastDue = addonEntitlementForSubscription(
    stripeSub({ ...addonBase, status: 'past_due' }),
    { id: 'evt_pd', type: 'customer.subscription.updated' },
    addons
  )
  assert.equal(pastDue?.status, 'past_due')
  assert.ok(pastDue?.graceUntil instanceof Date)

  const incomplete = addonEntitlementForSubscription(
    stripeSub({ ...addonBase, status: 'incomplete' }),
    { id: 'evt_inc', type: 'customer.subscription.created' },
    addons
  )
  assert.equal(incomplete, null)
})

test('pathAfterCheckout routes pending add-on Checkout to billing pending banner instead of pricing', async () => {
  const path = await pathAfterCheckout(
    'addon_pending',
    '/settings/billing?x_links=enabled',
    async () => '/home'
  )
  assert.equal(path, '/settings/billing?x_links=pending')
})
