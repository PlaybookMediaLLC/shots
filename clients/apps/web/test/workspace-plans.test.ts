import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  evaluateWorkspaceFeature,
  getMinimumPlan,
  getWorkspaceQuota,
  hasWorkspaceFeature,
  planPriceSummary,
  workspaceFeatureSchema,
  workspacePlanSchema,
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
  assert.equal(
    hasWorkspaceFeature('pro', 'campaign:workflow', { 'campaign:workflow': false }),
    false
  )
})

test('contract overrides can grant or revoke one feature without changing plans', () => {
  assert.equal(hasWorkspaceFeature('free', 'asset:delete', { 'asset:delete': true }), true)
  assert.equal(
    hasWorkspaceFeature('enterprise', 'enterprise:scim', { 'enterprise:scim': false }),
    false
  )
})

test('expired and suspended plans fail closed before feature execution', () => {
  const now = new Date('2026-08-26T12:00:00.000Z')
  assert.equal(
    evaluateWorkspaceFeature(
      { plan: 'enterprise', status: 'active', validUntil: new Date('2026-08-26T11:59:59Z') },
      'enterprise:sso',
      now
    ).allowed,
    false
  )
  assert.equal(
    evaluateWorkspaceFeature({ plan: 'enterprise', status: 'suspended' }, 'enterprise:sso', now)
      .allowed,
    false
  )
})

test('unknown plans fail closed', () => {
  const decision = evaluateWorkspaceFeature(
    { featureOverrides: { unknown: true }, plan: 'untrusted-tier', status: 'active' },
    'asset:delete'
  )
  assert.deepEqual(decision, {
    allowed: false,
    currentPlan: 'free',
    requiredPlan: 'pro',
  })
  assert.equal(
    evaluateWorkspaceFeature({ plan: 'untrusted-tier', status: 'active' }, 'content:drafts')
      .allowed,
    false
  )
})

test('past-due workspaces retain access only during the explicit billing grace period', () => {
  const now = new Date('2026-08-26T12:00:00.000Z')
  assert.equal(
    evaluateWorkspaceFeature(
      { graceUntil: new Date('2026-08-27T12:00:00.000Z'), plan: 'pro', status: 'past_due' },
      'asset:delete',
      now
    ).allowed,
    true
  )
  assert.equal(
    evaluateWorkspaceFeature(
      { graceUntil: new Date('2026-08-26T11:59:59.000Z'), plan: 'pro', status: 'past_due' },
      'asset:delete',
      now
    ).allowed,
    false
  )
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

test('each feature needs the plan the Go backend requires, and plans grant by that rank', () => {
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
    /(?:"([^"]+)"|(\w+Feature)): "(\w+)"/g
  )) {
    const feature = literal ?? constants.get(constant ?? '')
    assert.ok(feature && plan, `unresolved feature ${constant}`)
    required.set(feature, plan)
  }
  const rank = workspacePlanSchema.options
  for (const feature of workspaceFeatureSchema.options) {
    assert.equal(getMinimumPlan(feature), required.get(feature), feature)
    for (const plan of rank)
      assert.equal(
        hasWorkspaceFeature(plan, feature),
        plan !== 'free' && rank.indexOf(plan) >= rank.indexOf(getMinimumPlan(feature)),
        `${plan} ${feature}`
      )
  }
  // The web does not offer creative sets, which an environment switch gates.
  const unmodeled = [...required.keys()].filter(
    (feature) => !workspaceFeatureSchema.safeParse(feature).success
  )
  assert.deepEqual(unmodeled, ['creative-sets:create'])
})
