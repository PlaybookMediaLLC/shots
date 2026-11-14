import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  automationActionSchema,
  automationActionTypeSchema,
  automationGraphSchema,
  automationFamilySchema,
  automationOutputsSchema,
  type AutomationOverview,
} from '../lib/api/contracts/release-automation'
import {
  automationHistoryFilterSchema,
  automationSourceModeSchema,
} from '../lib/api/contracts/workflow-runs'
import {
  graphSchemaVersion,
  producersOf,
  savedGraph,
  WORKFLOW_ACTIONS,
  WORKFLOW_SCHEMA_VERSION,
} from '../lib/workflows/actions'
import {
  buildWorkflowTemplate,
  defaultTemplateInput,
  WORKFLOW_TEMPLATES,
  workflowTemplateIdSchema,
} from '../lib/workflows/templates'

// The Go validator reads the same file in server/internal/releaseautomation,
// so a template that drifts from the executor's language fails on both sides.
const fixture = JSON.parse(
  readFileSync(
    '../../../server/internal/releaseautomation/testdata/workflow-templates.json',
    'utf8'
  )
)

test('templates build the shared fixture graphs the Go validator accepts', () => {
  const base = {
    brandKitId: 'brand-fixture',
    destinationIds: ['destination-fixture'],
    branch: 'main',
  }
  const variants = {
    '': {
      creditLimit: 0,
      aiRelevance: false,
      majorMinorOnly: false,
      renderTemplateIds: [],
      canvas: false,
    },
    '+all': {
      creditLimit: 40,
      aiRelevance: true,
      majorMinorOnly: true,
      renderTemplateIds: ['layout-browser-launch', 'layout-phone-duo'],
      canvas: true,
    },
  }
  for (const id of workflowTemplateIdSchema.options) {
    for (const [suffix, options] of Object.entries(variants)) {
      const { graph, layout } = buildWorkflowTemplate(id, { ...base, ...options })
      assert.deepEqual(graph, fixture[`${id}${suffix}`])
      assert.deepEqual(automationGraphSchema.parse(graph), graph)
      assert.equal(graph.schemaVersion, WORKFLOW_SCHEMA_VERSION)
      assert.deepEqual(Object.keys(layout).sort(), graph.nodes.map((node) => node.id).sort())
    }
  }
})

test('templates list the events in the same order as the event menus', () => {
  assert.deepEqual(
    WORKFLOW_TEMPLATES.map((template) => template.family),
    automationFamilySchema.options
  )
})

test('a template starts from what the workspace has, without inventing a choice', () => {
  const overview = {
    actions: [],
    brands: [{ id: 'brand', name: 'Brand' }],
    definitions: [],
    destinations: [
      { id: 'first', name: 'First' },
      { id: 'second', name: 'Second' },
    ],
    executorAvailable: true,
    fields: {},
    sources: [
      { branch: 'old', connectionState: 'disconnected' },
      { branch: 'trunk', connectionState: 'connected' },
    ],
  } as unknown as AutomationOverview
  const release = WORKFLOW_TEMPLATES.find((template) => template.id === 'release-launch')!
  const milestone = WORKFLOW_TEMPLATES.find((template) => template.id === 'milestone-release')!
  const input = defaultTemplateInput(release, overview)
  assert.equal(input.brandKitId, 'brand')
  assert.deepEqual(input.destinationIds, ['first'])
  // Paid AI stays off unless the backend says it can run.
  assert.equal(input.creditLimit, 0)
  assert.equal(input.branch, 'trunk')
  assert.equal(input.majorMinorOnly, true)
  assert.equal(defaultTemplateInput(milestone, overview).majorMinorOnly, false)
  const generating = defaultTemplateInput(release, {
    ...overview,
    actions: [{ available: true, reason: '', type: 'generate_copy' }],
  })
  assert.equal(generating.creditLimit, 25)
  // An empty workspace leaves its choices for the Setup tab and the backend's validation.
  const empty = defaultTemplateInput(release, {
    ...overview,
    brands: [],
    destinations: [],
    sources: [],
  })
  assert.equal(empty.brandKitId, '')
  assert.deepEqual(empty.destinationIds, [])
  assert.equal(empty.branch, 'main')
})

test('a deployment template captures before it renders, on the language version it needs', () => {
  const { graph, layout } = buildWorkflowTemplate('deployment-marketing', {
    brandKitId: 'brand-fixture',
    destinationIds: ['destination-fixture'],
    branch: 'main',
    creditLimit: 0,
    aiRelevance: false,
    majorMinorOnly: false,
    renderTemplateIds: ['layout-browser-launch'],
    canvas: false,
    capture: { surfaceId: 'surface-fixture', versionPath: '/api/version' },
  })
  assert.deepEqual(graph, fixture['deployment-marketing+capture'])
  assert.deepEqual(automationGraphSchema.parse(graph), graph)
  assert.equal(graph.schemaVersion, 3)
  assert.deepEqual(Object.keys(layout).sort(), graph.nodes.map((node) => node.id).sort())
  const art = graph.nodes.find((node) => node.id === 'art')?.action
  assert.equal(art?.type, 'render_creatives')
  assert.deepEqual(art.input, { nodeId: 'capture', output: 'campaignId' })
  // Only a template that captures needs the newer worker.
  const { graph: release } = buildWorkflowTemplate('release-launch', {
    brandKitId: 'brand-fixture',
    destinationIds: ['destination-fixture'],
    branch: 'main',
    creditLimit: 0,
    aiRelevance: false,
    majorMinorOnly: false,
    renderTemplateIds: [],
    canvas: false,
    capture: { surfaceId: 'surface-fixture' },
  })
  assert.equal(
    release.nodes.some((node) => node.action?.type === 'capture_product'),
    false
  )
  assert.equal(release.schemaVersion, WORKFLOW_SCHEMA_VERSION)
  assert.equal(graphSchemaVersion(graph), 3)
  assert.equal(savedGraph({ ...graph, schemaVersion: 2 }).schemaVersion, 3)
  assert.equal(savedGraph({ ...release, schemaVersion: 1 }).schemaVersion, WORKFLOW_SCHEMA_VERSION)
})

test('a capture action may name a signed-in recipe instead of a public page', () => {
  const action = { type: 'capture_product', recipeId: 'recipe-1', currentState: true }
  assert.deepEqual(automationActionSchema.parse(action), action)
  const tooLong = { type: 'capture_product', recipeId: 'r'.repeat(65) }
  assert.equal(automationActionSchema.safeParse(tooLong).success, false)
})

test('capture evidence reaches copy generation before editable drafts are reviewed', () => {
  const { graph } = buildWorkflowTemplate('deployment-marketing', {
    brandKitId: 'brand-fixture',
    destinationIds: ['destination-fixture'],
    branch: 'main',
    creditLimit: 25,
    aiRelevance: false,
    majorMinorOnly: false,
    renderTemplateIds: ['layout-browser-launch'],
    canvas: false,
    capture: { surfaceId: 'surface-fixture' },
  })
  assert.deepEqual(automationGraphSchema.parse(graph), graph)
  const copy = graph.nodes.find((node) => node.id === 'copy')?.action
  const art = graph.nodes.find((node) => node.id === 'art')?.action
  assert.ok(copy?.type === 'generate_copy')
  assert.ok(art?.type === 'render_creatives')
  assert.deepEqual(copy.input, {
    nodeId: 'capture',
    output: 'campaignId',
  })
  assert.deepEqual(art.input, {
    nodeId: 'copy',
    output: 'campaignId',
  })
  const outputs = { campaignId: 'campaign-fixture', draftIds: ['draft-one', 'draft-two'] }
  assert.deepEqual(automationOutputsSchema.parse(outputs), outputs)
})

test('the action registry covers every executor action and wires outputs to inputs', () => {
  assert.deepEqual(
    Object.keys(WORKFLOW_ACTIONS).sort(),
    [...automationActionTypeSchema.options].sort()
  )
  assert.deepEqual(producersOf('submit_review'), [
    'create_campaign',
    'generate_copy',
    'capture_product',
    'render_creatives',
    'render_code_visual',
  ])
  assert.deepEqual(producersOf('create_campaign'), ['create_release'])
  assert.deepEqual(producersOf('create_release'), [])
  for (const spec of Object.values(WORKFLOW_ACTIONS)) {
    assert.equal(spec.paid, spec.type === 'generate_copy')
    assert.equal(spec.humanApproval, spec.type === 'submit_review')
  }
})

test('action configurations are a discriminated union with no publishing or approval action', () => {
  assert.ok(automationActionSchema.safeParse({ type: 'generate_copy', creditLimit: 40 }).success)
  assert.ok(automationActionSchema.safeParse({ type: 'create_campaign' }).success)
  assert.ok(
    automationActionSchema.safeParse({ type: 'create_release', include: 'unreleased' }).success
  )
  assert.equal(
    automationActionSchema.safeParse({ type: 'create_release', include: 'all' }).success,
    false
  )
  assert.ok(
    automationActionSchema.safeParse({
      type: 'render_creatives',
      templateIds: ['layout-phone-duo'],
    }).success
  )
  assert.ok(
    automationActionSchema.safeParse({
      type: 'capture_product',
      surfaceId: 'surface',
      versionPath: '/api/version',
    }).success
  )
  for (const type of ['publish', 'approve', 'schedule', 'notify']) {
    assert.equal(automationActionSchema.safeParse({ type }).success, false, type)
  }
  assert.equal(
    automationActionSchema.safeParse({ type: 'generate_copy', creditLimit: 501 }).success,
    false
  )
})

test('run filters and source modes reject unknown or unsafe values', () => {
  assert.ok(automationHistoryFilterSchema.safeParse({ status: 'needs_attention' }).success)
  for (const invalid of [
    { status: 'approved' },
    { organizationId: 'other' },
    { since: 'yesterday' },
  ]) {
    assert.equal(automationHistoryFilterSchema.safeParse(invalid).success, false)
  }
  assert.ok(
    automationSourceModeSchema.safeParse({ id: 's', enabled: true, branch: 'release/2026' }).success
  )
  for (const branch of ['bad..name', '-flag', 'has space', 'a:b']) {
    assert.equal(
      automationSourceModeSchema.safeParse({ id: 's', enabled: true, branch }).success,
      false,
      branch
    )
  }
})

test('worker render signatures verify only fresh, exact bodies', async () => {
  const { createHmac } = await import('node:crypto')
  const { verifyWorkflowRenderSignature } = await import('../lib/workflows/render-signature')
  const key = 'k'.repeat(40)
  const body = '{"organizationId":"org"}'
  const now = Date.UTC(2026, 9, 20)
  const sign = (at: number, text = body) =>
    `t=${at},v1=${createHmac('sha256', key).update(`${at}.${text}`).digest('hex')}`
  const stamp = now / 1000
  assert.ok(verifyWorkflowRenderSignature(body, sign(stamp), key, now))
  assert.equal(verifyWorkflowRenderSignature(`${body} `, sign(stamp), key, now), false)
  assert.equal(verifyWorkflowRenderSignature(body, sign(stamp - 301), key, now), false)
  assert.equal(verifyWorkflowRenderSignature(body, sign(stamp), 'short', now), false)
  assert.equal(verifyWorkflowRenderSignature(body, null, key, now), false)
  // The Go signer produces this exact header (release_automation_render_test.go).
  assert.ok(
    verifyWorkflowRenderSignature(
      body,
      't=1792454400,v1=8e82175971c0945959d8004b2d126c6b4631ba7f718daaf2e9a1126ce8d64d76',
      key,
      1792454400_000
    )
  )
})
