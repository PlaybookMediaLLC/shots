import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  getMinimumPlan,
  getWorkspaceQuota,
  includedAllowance,
  hasWorkspaceFeature,
  planPriceSummary,
  workspaceFeatureSchema,
  workspaceQuotaSchema,
} from '@/lib/billing/plans'

test('free workspaces cannot delete assets', () => {
  assert.equal(hasWorkspaceFeature('free', 'asset:delete'), false)
  assert.equal(getMinimumPlan('asset:delete'), 'pro')
})

test('paid workspaces can delete assets', () => {
  assert.equal(hasWorkspaceFeature('pro', 'asset:delete'), true)
  assert.equal(hasWorkspaceFeature('business', 'asset:delete'), true)
  assert.equal(hasWorkspaceFeature('enterprise', 'asset:delete'), true)
})

test('resource update paths can use the same named feature gate', () => {
  assert.equal(hasWorkspaceFeature('free', 'asset:update'), false)
  assert.equal(hasWorkspaceFeature('pro', 'asset:update'), true)
  assert.equal(getMinimumPlan('asset:update'), 'pro')
})

test('enterprise-only features remain unavailable to lower plans', () => {
  assert.equal(hasWorkspaceFeature('business', 'enterprise:sso'), false)
  assert.equal(hasWorkspaceFeature('enterprise', 'enterprise:sso'), true)
})

test('every paid plan includes the campaign workflow', () => {
  assert.equal(hasWorkspaceFeature('free', 'campaign:workflow'), false)
  assert.equal(hasWorkspaceFeature('pro', 'campaign:workflow'), true)
  assert.equal(hasWorkspaceFeature('business', 'campaign:workflow'), true)
  assert.equal(hasWorkspaceFeature('enterprise', 'campaign:workflow'), true)
  assert.equal(getMinimumPlan('campaign:workflow'), 'pro')
})

test('plan quotas increase for API writes and storage', () => {
  assert(
    getWorkspaceQuota('free', 'api:write:minute') < getWorkspaceQuota('pro', 'api:write:minute')
  )
  assert(
    getWorkspaceQuota('business', 'storage:bytes') <
      getWorkspaceQuota('enterprise', 'storage:bytes')
  )
})

test('there is no free plan: a workspace without a subscription gets no feature or allowance', () => {
  for (const feature of workspaceFeatureSchema.options) {
    assert.equal(hasWorkspaceFeature('free', feature), false, feature)
  }
  for (const quota of workspaceQuotaSchema.options) {
    assert.equal(getWorkspaceQuota('free', quota), 0, quota)
  }
  assert.equal(getMinimumPlan('content:drafts'), 'pro')
  assert.equal(hasWorkspaceFeature('pro', 'content:drafts'), true)
  assert.equal(hasWorkspaceFeature('pro', 'content:scheduling-advanced'), true)
})

test('plan prices derive annual billing at 15% off, matching the Stripe prices', () => {
  assert.equal(planPriceSummary('pro'), '$29/mo, or $25/mo billed annually')
  assert.equal(planPriceSummary('business'), '$79/mo, or $67/mo billed annually')
  assert.equal(planPriceSummary('enterprise'), 'from $799/mo, billed annually')
})

test('the static llm.txt quotes the current plan prices', () => {
  // shortcut: public/llm.txt is hand-written; regenerate it from lib/agents/llms.ts if it grows.
  const text = readFileSync('public/llm.txt', 'utf8')
  for (const plan of ['pro', 'business', 'enterprise'] as const) {
    assert.ok(
      text.includes(planPriceSummary(plan)),
      `public/llm.txt lacks ${planPriceSummary(plan)}`
    )
  }
})

test('each feature needs the plan the Go backend requires', () => {
  const product = '../../../server/internal/product/'
  const go = readFileSync(`${product}entitlements.go`, 'utf8')
  const block = go.match(/minimumFeaturePlan = map\[string\]string\{([\s\S]*?)\n\}/)?.[1]
  assert.ok(block, 'entitlements.go has no minimumFeaturePlan')
  const constants = new Map<string, string>()
  for (const file of [
    'onboarding.go',
    'creative_set_validation.go',
    'whitelabel.go',
    'permission_groups.go',
  ]) {
    for (const [, name, value] of readFileSync(`${product}${file}`, 'utf8').matchAll(
      /const (\w+Feature) = "([^"]+)"/g
    ))
      if (name && value) constants.set(name, value)
  }
  const required = new Map<string, string>()
  for (const [, literal, constant, plan] of block.matchAll(
    /(?:"([^"]+)"|(\w+Feature)):\s+"(\w+)"/g
  )) {
    const feature = literal ?? constants.get(constant ?? '')
    assert.ok(feature && plan, `unresolved feature ${constant}`)
    required.set(feature, plan)
  }
  // Every entry was read: none is spelled in a way the pattern above skips.
  assert.equal(block.match(/:\s+"/g)?.length, required.size)
  for (const feature of workspaceFeatureSchema.options)
    assert.equal(getMinimumPlan(feature), required.get(feature), feature)
  // The web does not offer creative sets, which an environment switch gates.
  const unmodeled = [...required.keys()].filter(
    (feature) => !workspaceFeatureSchema.safeParse(feature).success
  )
  assert.deepEqual(unmodeled, ['creative-sets:create'])
})

test('the billing page shows what the backend says a plan includes', () => {
  // A lapsed Pro plan includes nothing, whatever the plan table says.
  assert.equal(includedAllowance({ 'posts:monthly': 0 }, 'pro', 'posts:monthly'), 0)
  assert.equal(includedAllowance({ 'posts:monthly': 250 }, 'pro', 'posts:monthly'), 250)
  // A backend older than its allowances sends none.
  assert.equal(
    includedAllowance(undefined, 'pro', 'posts:monthly'),
    getWorkspaceQuota('pro', 'posts:monthly')
  )
})
