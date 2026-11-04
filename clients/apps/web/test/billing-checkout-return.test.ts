import assert from 'node:assert/strict'
import test from 'node:test'
import { completeCheckoutContract, createBillingSessionContract } from '@/lib/api/contracts/billing'
import {
  checkoutRedirects,
  checkoutReturnFor,
  pathAfterCheckout,
} from '@/lib/billing/stripe-events'

const session = (client_reference_id: string | null) => ({ client_reference_id })

test('a returning Checkout is refused unless it was started for the active workspace', () => {
  const paid = { plan: 'pro', status: 'active' } as const
  assert.equal(checkoutReturnFor(session('org_other'), 'org_1', paid), 'mismatch')
  assert.equal(checkoutReturnFor(session(null), 'org_1', paid), 'mismatch')
  assert.equal(checkoutReturnFor(null, 'org_1', null), 'mismatch')
})

test('a returning Checkout opens the app only once a paid plan is in good standing', () => {
  const at = (plan: 'free' | 'pro', status: 'active' | 'past_due' | 'trialing') =>
    checkoutReturnFor(session('org_1'), 'org_1', { plan, status })
  assert.equal(at('pro', 'active'), 'success')
  assert.equal(at('pro', 'trialing'), 'success')
  assert.equal(at('pro', 'past_due'), 'pending')
  assert.equal(at('free', 'active'), 'pending')
  assert.equal(checkoutReturnFor(session('org_1'), 'org_1', null), 'pending')
})

test('Checkout keeps the page the buyer was sent from, whether they pay or cancel', () => {
  assert.deepEqual(checkoutRedirects('/publish?set=abc'), {
    cancel: '/pricing?checkout=cancelled&returnTo=%2Fpublish%3Fset%3Dabc',
    success:
      '/api/billing/checkout/return?session_id={CHECKOUT_SESSION_ID}&returnTo=%2Fpublish%3Fset%3Dabc',
  })
  assert.deepEqual(checkoutRedirects(), {
    cancel: '/pricing?checkout=cancelled',
    success: '/api/billing/checkout/return?session_id={CHECKOUT_SESSION_ID}',
  })
})

test('a paid buyer returns to the page they asked for, before onboarding or the app', async () => {
  let asked = 0
  const appPath = async () => {
    asked += 1
    return '/onboarding/product?checkout=success'
  }
  assert.equal(await pathAfterCheckout('success', '/publish', appPath), '/publish')
  assert.equal(asked, 0)
  assert.equal(
    await pathAfterCheckout('success', undefined, appPath),
    '/onboarding/product?checkout=success'
  )
  // Pricing waits for the webhook, then opens the same page.
  assert.equal(
    await pathAfterCheckout('pending', '/publish', appPath),
    '/pricing?checkout=pending&returnTo=%2Fpublish'
  )
  assert.equal(await pathAfterCheckout('pending', undefined, appPath), '/pricing?checkout=pending')
})

test('only an in-app path is carried through Checkout', () => {
  const body = (returnTo: string) =>
    createBillingSessionContract.body.safeParse({ plan: 'pro', returnTo }).success
  assert.equal(body('/publish?set=abc'), true)
  for (const unsafe of ['//evil.test', 'https://evil.test', '/\\evil.test', 'write'])
    assert.equal(body(unsafe), false, unsafe)
  // The return route has already been paid for: it drops a bad value instead of failing.
  assert.deepEqual(
    completeCheckoutContract.query.parse({ returnTo: '//evil.test', session_id: 'cs_1' }),
    { returnTo: undefined, session_id: 'cs_1' }
  )
})
