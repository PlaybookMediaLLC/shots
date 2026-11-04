import assert from 'node:assert/strict'
import test from 'node:test'
import { generateText, stepCountIs } from 'ai'
import type { BackendAuditEvent } from 'screenshot-studio-backend-sdk'
import { createScriptedModel } from '@/lib/ai/models/scripted'
import { createToolRun, flushToolRun, isRunStopped } from '@/lib/ai/tools/executor'
import { type MarketingServices, marketingTools } from '@/lib/ai/tools/marketing'
import type { OrganizationRole } from '@/lib/auth/permissions'

const CAMPAIGN = 'cjld2cjxh0000qzrmn831i7rn'
const POSTS = ['cjld2cjxh0001qzrmn831i7rn', 'cjld2cjxh0002qzrmn831i7rn']

const surface = {
  description: 'Where invoices are scheduled.',
  featureTags: ['invoices'],
  id: 'surface_1',
  name: 'Invoices',
  screenshotAssetIds: [],
  slug: 'invoices',
  url: 'https://app.ledgerly.example/invoices',
}

/** Fake domain services that record what the tools asked for. */
function fakeServices() {
  const calls: Array<{ args: unknown[]; name: string }> = []
  const record =
    (name: string, value: unknown) =>
    async (...args: unknown[]) => {
      calls.push({ args: args.slice(1), name })
      return value
    }
  const services = {
    captureProductSurface: record('captureProductSurface', {
      capture: { assetId: 'asset_1' },
    }),
    findSurfacesForFeature: record('findSurfacesForFeature', [
      { currentCaptureAssetId: 'asset_0', reason: 'tag', score: 100, surface },
    ]),
    getActiveBrand: record('getActiveBrand', { kit: null, profile: null }),
    getProductProfile: record('getProductProfile', {
      audience: 'Freelancers',
      capabilities: ['Recurring invoices'],
      competitors: [],
      createdAt: new Date(),
      id: 'profile_1',
      name: 'Ledgerly',
      pricingNote: '',
      problem: 'Chasing invoices.',
      proofPoints: [],
      provenance: {},
      summary: 'Invoices that send themselves.',
      updatedAt: new Date(),
      url: 'https://ledgerly.example',
    }),
    listProductSurfaces: record('listProductSurfaces', [surface]),
    transitionCampaignPosts: record('transitionCampaignPosts', {
      postIds: POSTS,
      status: 'READY_FOR_REVIEW',
    }),
  } as unknown as MarketingServices
  return { calls, services }
}

function setup(role: OrganizationRole = 'creator', campaignId: string | null = CAMPAIGN) {
  const events: BackendAuditEvent[] = []
  const run = createToolRun({
    access: {
      deniedPermissions: [],
      organizationId: 'org_1',
      principal: { display: 'ada@example.com', kind: 'session', sessionId: 's_1', userId: 'u_1' },
      requestId: 'req_1',
      role,
    },
    audit: async (event) => {
      events.push(event)
    },
  })
  const { calls, services } = fakeServices()
  return {
    calls,
    events,
    run,
    tools: marketingTools(run, { campaignId: campaignId ?? undefined, services }),
  }
}

const options = { context: undefined as never, messages: [], toolCallId: 'call_1' }

test('getProduct returns the profile without ids, dates, or provenance', async () => {
  const { tools } = setup('viewer')
  const result = await tools.getProduct.execute({}, options)
  assert.ok(result.ok && result.product)
  assert.equal(result.product.name, 'Ledgerly')
  assert.ok(!('id' in result.product) && !('provenance' in result.product))
})

test('listProductSurfaces ranks by feature and lists by slug otherwise', async () => {
  const { calls, tools } = setup('viewer')
  const ranked = await tools.listProductSurfaces.execute({ feature: 'invoices', limit: 5 }, options)
  assert.ok(ranked.ok)
  assert.deepEqual(ranked.surfaces[0], {
    captured: true,
    description: surface.description,
    featureTags: ['invoices'],
    name: 'Invoices',
    reason: 'tag',
    score: 100,
    slug: 'invoices',
  })
  assert.deepEqual(calls[0], {
    args: [{ feature: 'invoices', limit: 5 }],
    name: 'findSurfacesForFeature',
  })
  const listed = await tools.listProductSurfaces.execute({ limit: 10 }, options)
  assert.ok(listed.ok && listed.surfaces[0]?.slug === 'invoices')
})

test('captureProductSurface resolves a slug and records an agent capture for the run', async () => {
  const { calls, run, tools } = setup()
  const result = await tools.captureProductSurface.execute({ slug: 'invoices' }, options)
  assert.deepEqual(result, { assetId: 'asset_1', ok: true, slug: 'invoices' })
  assert.deepEqual(calls.at(-1), {
    args: ['surface_1', { source: 'agent', sourceId: run.runId }],
    name: 'captureProductSurface',
  })
})

test('captureProductSurface refuses a slug the workspace did not register', async () => {
  const { calls, tools } = setup()
  const result = await tools.captureProductSurface.execute(
    { slug: 'https://evil.example' },
    options
  )
  assert.equal(result.ok, false)
  assert.ok(!calls.some((entry) => entry.name === 'captureProductSurface'))
})

test('requestApproval only ever submits', async () => {
  const { calls, tools } = setup()
  const result = await tools.requestApproval.execute({ postIds: POSTS }, options)
  assert.deepEqual(result, { ok: true, status: 'READY_FOR_REVIEW', submitted: POSTS })
  assert.deepEqual(calls.at(-1), {
    args: [CAMPAIGN, 'submit', POSTS],
    name: 'transitionCampaignPosts',
  })
})

test('a viewer can read but cannot capture or submit', async () => {
  const { calls, tools } = setup('viewer')
  const capture = await tools.captureProductSurface.execute({ slug: 'invoices' }, options)
  const submit = await tools.requestApproval.execute({ postIds: POSTS }, options)
  assert.equal(!capture.ok && 'code' in capture && capture.code, 'DENIED')
  assert.equal(!submit.ok && 'code' in submit && submit.code, 'DENIED')
  assert.deepEqual(calls, [])
})

test('requestApproval refuses without a campaign', async () => {
  const { calls, tools } = setup('creator', null)
  const result = await tools.requestApproval.execute({ postIds: POSTS }, options)
  assert.equal(result.ok, false)
  assert.deepEqual(calls, [])
})

test('the scripted agent reads the product and brand, then submits for review', async () => {
  const { calls, events, run, tools } = setup()
  const result = await generateText({
    model: createScriptedModel('test'),
    prompt: `Submit the launch posts for review.\n\nPost ids: ${POSTS.join(', ')}`,
    stopWhen: [stepCountIs(6), isRunStopped(run)],
    tools,
  })
  await flushToolRun(run)
  assert.deepEqual(
    result.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName)),
    ['getProduct', 'getBrand', 'requestApproval']
  )
  assert.deepEqual(calls.at(-1)?.args, [CAMPAIGN, 'submit', POSTS])
  assert.deepEqual(
    events.map((event) => [event.metadata?.tool, event.outcome]),
    [
      ['getProduct', 'SUCCEEDED'],
      ['getBrand', 'SUCCEEDED'],
      ['requestApproval', 'SUCCEEDED'],
    ]
  )
})
