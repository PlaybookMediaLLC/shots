import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type Stripe from 'stripe'
import { createAiCreditMeter } from '@/lib/ai/metering/meter'
import {
  callCostUsd,
  callTokens,
  settleCredits,
  splitCredits,
  tokenCostUsd,
} from '@/lib/ai/metering/pricing'
import { createMeterMiddleware, type ModelCallMeter } from '@/lib/ai/models/middleware/meter'
import {
  getWorkspaceLimit,
  getWorkspaceQuota,
  type WorkspaceLimit,
  workspacePlanSchema,
} from '@/lib/billing/plans'
import {
  creditGrantForSession,
  entitlementForSubscription,
  governingSubscription,
} from '@/lib/billing/stripe-events'

const SONNET = 'anthropic/claude-sonnet-5.5'

test('a call is priced from cached, uncached, and output tokens', () => {
  const usage = {
    inputTokens: { cacheRead: 90_000, cacheWrite: 5_000, noCache: 5_000, total: 100_000 },
    outputTokens: { reasoning: 0, text: 1_000, total: 1_000 },
  }
  assert.deepEqual(callTokens(usage), {
    cacheRead: 90_000,
    cacheWrite: 5_000,
    input: 5_000,
    output: 1_000,
  })
  // 5K × $2 + 90K × $0.20 + 5K × $2.50 + 1K × $10, per million.
  assert.equal(tokenCostUsd(SONNET, callTokens(usage)).toFixed(4), '0.0505')
  // An unlisted model is priced as the most expensive one.
  assert.ok(
    tokenCostUsd('openai/unknown', callTokens(usage)) > tokenCostUsd(SONNET, callTokens(usage))
  )
})

test("the provider's reported cost wins over the token estimate", () => {
  const usage = { inputTokens: { total: 1_000_000 }, outputTokens: { total: 0 } }
  assert.equal(callCostUsd(SONNET, usage, { openrouter: { usage: { cost: 0.42 } } }), 0.42)
  assert.equal(callCostUsd(SONNET, usage, { openrouter: { usage: {} } }), 2)
})

test('credits are whole cents, with the remainder carried and settled up', () => {
  assert.deepEqual(splitCredits(0.07 + 0.03), { carryUsd: 0, credits: 10 })
  const split = splitCredits(0.125)
  assert.equal(split.credits, 12)
  assert.equal(split.carryUsd.toFixed(3), '0.005')
  assert.equal(settleCredits(0.0001), 1)
  assert.equal(settleCredits(0.03), 3)
  assert.equal(settleCredits(0), 0)
})

function fakeBackend(start: number) {
  const ledger = { charges: [] as number[], remaining: start }
  const consume = async (_tenant: { organizationId: string }, amount: number) => {
    if (amount === 0 && ledger.remaining <= 0) {
      throw Object.assign(new Error('quota'), { name: 'WorkspaceQuotaError' })
    }
    ledger.charges.push(amount)
    ledger.remaining -= amount
    if (ledger.remaining < 0) {
      throw Object.assign(new Error('quota'), { name: 'WorkspaceQuotaError' })
    }
    return ledger.remaining
  }
  return { ledger, ...createAiCreditMeter(consume) }
}

const tenant = { organizationId: 'org_1' }

test('an action pays whole credits as it goes and settles its remainder', async () => {
  const { ledger, meter, withAiCredits } = fakeBackend(100)
  await withAiCredits(tenant, async () => {
    for (const cost of [0.004, 0.004, 0.015]) (await meter.admit())(cost)
  })
  // 0.008 carries, then 0.023 charges 2 credits and carries 0.003, settled as 1.
  assert.deepEqual(ledger.charges, [0, 2, 1])
  assert.equal(ledger.remaining, 97)
})

test('model calls are refused outside an action and once credits run out', async () => {
  const { ledger, meter, withAiCredits } = fakeBackend(5)
  await assert.rejects(meter.admit(), /outside a metered AI action/)
  await assert.rejects(
    withAiCredits(tenant, async () => {
      await (
        await meter.admit()
      )(0.08)
      await (
        await meter.admit()
      )(0.01)
    }),
    { name: 'WorkspaceQuotaError' }
  )
  // The overrunning call is still recorded; nothing after it ran.
  assert.deepEqual(ledger.charges, [0, 8])
  const work = { ran: false }
  await assert.rejects(
    withAiCredits(tenant, async () => {
      work.ran = true
    }),
    { name: 'WorkspaceQuotaError' }
  )
  assert.equal(work.ran, false)
})

test('the middleware never calls a model the meter refuses, and records what a call cost', async () => {
  const recorded: number[] = []
  const meter = (allow: boolean): ModelCallMeter => ({
    admit: async () => {
      if (!allow) throw new Error('refused')
      return async (cost) => {
        recorded.push(cost)
      }
    },
  })
  const result = {
    content: [],
    finishReason: 'stop',
    providerMetadata: { openrouter: { usage: { cost: 0.031 } } },
    usage: {},
    warnings: [],
  }
  const calls = { count: 0 }
  const doGenerate = async () => {
    calls.count += 1
    return result
  }
  const call = async (allow: boolean) =>
    createMeterMiddleware(SONNET, meter(allow)).wrapGenerate!({
      doGenerate,
      doStream: async () => {
        throw new Error('unused')
      },
      model: {},
      params: {},
    } as unknown as Parameters<
      NonNullable<ReturnType<typeof createMeterMiddleware>['wrapGenerate']>
    >[0])
  await assert.rejects(call(false), /refused/)
  assert.equal(calls.count, 0)
  await call(true)
  assert.deepEqual(recorded, [0.031])
})

test('plan allowances match the Go backend', () => {
  const go = readFileSync('../../../server/internal/product/quota.go', 'utf8')
  const names: Record<string, string> = {
    QuotaAICredits: 'ai:credits:monthly',
    QuotaAPIWriteMinute: 'api:write:minute',
    QuotaEmails: 'emails:monthly',
    QuotaJobsConcurrent: 'jobs:concurrent',
    QuotaPosts: 'posts:monthly',
  }
  for (const plan of workspacePlanSchema.options) {
    const block = go.match(new RegExp(`"${plan}": \\{([^}]*)\\}`))?.[1]
    assert.ok(block, `quota.go has no ${plan} plan`)
    const pairs = [...block.matchAll(/(\w+): ([\d_]+)/g)]
    assert.equal(pairs.length, Object.keys(names).length, `${plan} quotas in quota.go`)
    for (const [, name, value] of pairs) {
      const quota = names[name] as Parameters<typeof getWorkspaceQuota>[1]
      assert.equal(
        getWorkspaceQuota(plan, quota),
        Number(value.replaceAll('_', '')),
        `${plan} ${quota}`
      )
    }
  }
  assert.equal(getWorkspaceQuota('pro', 'ai:credits:monthly'), 600)
  const media = readFileSync('../../../server/internal/product/assets_media.go', 'utf8')
  const storage = media.match(/storageLimits = map\[string\]int64\{([^}]*)\}/)?.[1]
  assert.ok(storage, 'assets_media.go has no storageLimits')
  const caps = [...storage.matchAll(/"(\w+)": (\d+)(?: << (\d+))?/g)]
  assert.equal(caps.length, workspacePlanSchema.options.length, 'storage caps in assets_media.go')
  for (const [, plan, value, shift] of caps) {
    assert.equal(
      getWorkspaceQuota(workspacePlanSchema.parse(plan), 'storage:bytes'),
      Number(value) * 2 ** Number(shift ?? 0),
      `${plan} storage:bytes`
    )
  }
})

test('plan seat and channel limits match the Go backend', () => {
  const go = readFileSync('../../../server/internal/workspaceplan/capacity.go', 'utf8')
  const names: Record<string, WorkspaceLimit> = { Channels: 'channels', Seats: 'seats' }
  for (const plan of workspacePlanSchema.options) {
    const block = go.match(new RegExp(`"${plan}": +\\{([^}]*)\\}`))?.[1]
    assert.ok(block, `workspaceplan/capacity.go has no ${plan} plan`)
    const pairs = [...block.matchAll(/(\w+): ([\w.]+)/g)]
    assert.equal(pairs.length, Object.keys(names).length, `${plan} limits in workspaceplan`)
    for (const [, name, value] of pairs) {
      assert.equal(
        getWorkspaceLimit(plan, names[name]),
        value === 'math.MaxInt32' ? null : Number(value),
        `${plan} ${name}`
      )
    }
  }
})

function subscription(
  status: string,
  price = 'price_pro',
  id = 'sub_1',
  created = 1
): Stripe.Subscription {
  return {
    created,
    customer: 'cus_1',
    id,
    items: { data: [{ current_period_start: 1_790_000_000, price: { id: price } }] },
    metadata: { organizationId: 'org_1' },
    status,
  } as unknown as Stripe.Subscription
}

test('a Stripe subscription maps to the workspace entitlement', () => {
  const plans = { price_business: 'business', price_pro: 'pro' } as const
  const event = { id: 'evt_1', type: 'customer.subscription.updated' }
  const active = entitlementForSubscription(subscription('active'), event, plans)
  assert.equal(active?.plan, 'pro')
  assert.equal(active?.status, 'active')
  assert.equal(active?.externalCustomerId, 'cus_1')
  assert.equal(active?.provider, 'stripe')

  const pastDue = entitlementForSubscription(subscription('past_due'), event, plans)
  assert.equal(pastDue?.status, 'past_due')
  assert.equal(
    (pastDue?.graceUntil as Date).toISOString(),
    new Date((1_790_000_000 + 14 * 86_400) * 1000).toISOString()
  )

  for (const ended of ['canceled', 'unpaid', 'incomplete_expired']) {
    const back = entitlementForSubscription(subscription(ended), event, plans)
    assert.deepEqual([back?.plan, back?.status], ['free', 'active'], ended)
  }
  assert.equal(entitlementForSubscription(subscription('incomplete'), event, plans), null)
  assert.equal(
    entitlementForSubscription(subscription('active', 'price_other'), event, plans),
    null
  )
})

test('the subscription that governs a workspace with several is the live, larger, newer one', () => {
  const plans = { price_business: 'business', price_pro: 'pro' } as const
  const pick = (...subscriptions: Stripe.Subscription[]) =>
    governingSubscription(subscriptions, plans)?.id
  // An old subscription ending does not downgrade a workspace with a live one.
  assert.equal(
    pick(
      subscription('canceled', 'price_business', 'old', 1),
      subscription('active', 'price_pro', 'new', 2)
    ),
    'new'
  )
  assert.equal(
    pick(
      subscription('active', 'price_pro', 'pro', 2),
      subscription('active', 'price_business', 'biz', 1)
    ),
    'biz'
  )
  assert.equal(
    pick(
      subscription('past_due', 'price_business', 'late', 2),
      subscription('trialing', 'price_pro', 'trial', 1)
    ),
    'trial'
  )
  assert.equal(
    pick(
      subscription('canceled', 'price_pro', 'a', 1),
      subscription('canceled', 'price_pro', 'b', 2)
    ),
    'b'
  )
  assert.equal(pick(subscription('active', 'price_other'), subscription('incomplete')), undefined)
  // A live subscription moved to a price not deployed yet keeps an ended one from downgrading.
  assert.equal(
    pick(
      subscription('active', 'price_new_pro', 'moved', 2),
      subscription('canceled', 'price_pro', 'old', 1)
    ),
    undefined
  )
})

test('a paid one-time Checkout session grants its packs once, by session id', () => {
  const packs = { price_launch: 'launch' } as const
  const session = (overrides: Record<string, unknown>) =>
    ({
      client_reference_id: 'org_1',
      id: 'cs_1',
      line_items: { data: [{ price: { id: 'price_launch' }, quantity: 2 }] },
      mode: 'payment',
      payment_status: 'paid',
      ...overrides,
    }) as unknown as Stripe.Checkout.Session
  assert.deepEqual(creditGrantForSession(session({}), packs), {
    credits: 1_000,
    organizationId: 'org_1',
    provider: 'stripe',
    reference: 'cs_1',
  })
  // A Checkout opened on the pack's previous price grants the pack it names.
  assert.equal(
    creditGrantForSession(
      session({
        line_items: { data: [{ price: { id: 'price_old_launch' }, quantity: 1 }] },
        metadata: { organizationId: 'org_1', pack: 'launch' },
      }),
      packs
    )?.credits,
    500
  )
  assert.equal(creditGrantForSession(session({ payment_status: 'unpaid' }), packs), null)
  assert.equal(creditGrantForSession(session({ mode: 'subscription' }), packs), null)
  assert.equal(creditGrantForSession(session({ client_reference_id: null }), packs), null)
  assert.equal(
    creditGrantForSession(
      session({ line_items: { data: [{ price: { id: 'price_other' }, quantity: 1 }] } }),
      packs
    ),
    null
  )
})

test('scheduleSettlement defers remainder settlement when accepted and falls back inline when declined', async () => {
  const charges: number[] = []
  let remaining = 50
  const consume = async (_tenant: { organizationId: string }, amount: number) => {
    charges.push(amount)
    remaining -= amount
    return remaining
  }

  // Accepted deferred settlement: withAiCredits returns before the remainder settles,
  // and running the scheduled task settles it afterwards (even when run() throws).
  const deferredTasks: Array<() => Promise<void>> = []
  const deferred = createAiCreditMeter(consume, {
    scheduleSettlement: (task) => {
      deferredTasks.push(task)
      return true
    },
  })
  const out = await deferred.withAiCredits(tenant, async () => {
    await (
      await deferred.meter.admit()
    )(0.004)
    return 'fast-reply'
  })
  assert.equal(out, 'fast-reply')
  assert.deepEqual(charges, [0])
  assert.equal(deferredTasks.length, 1)
  await deferredTasks.shift()!()
  assert.deepEqual(charges, [0, 1])

  await assert.rejects(
    deferred.withAiCredits(tenant, async () => {
      await (
        await deferred.meter.admit()
      )(0.003)
      throw new Error('stream aborted')
    }),
    /stream aborted/
  )
  assert.equal(deferredTasks.length, 1)
  await deferredTasks.shift()!()
  assert.deepEqual(charges, [0, 1, 0, 1])

  // Declined deferred settlement: settles synchronously before withAiCredits resolves.
  const inline = createAiCreditMeter(consume, {
    scheduleSettlement: () => false,
  })
  await inline.withAiCredits(tenant, async () => {
    await (
      await inline.meter.admit()
    )(0.002)
  })
  assert.deepEqual(charges, [0, 1, 0, 1, 0, 1])
})
