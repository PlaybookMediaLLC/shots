import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createToolRun } from '@/lib/ai/tools/executor'
import {
  type AssistantTurnState,
  workspaceAssistantTools,
} from '@/lib/ai/tools/workspace-assistant'
import type { OrganizationRole } from '@/lib/auth/permissions'

function setup(role: OrganizationRole) {
  const run = createToolRun({
    access: {
      deniedPermissions: [],
      organizationId: 'org_1',
      principal: { display: 'ada@example.com', kind: 'session', sessionId: 's_1', userId: 'u_1' },
      requestId: 'req_1',
      role,
    },
    audit: async () => {},
  })
  const state: AssistantTurnState = { known: new Set(['/home']), links: [], posts: [] }
  return { state, tools: workspaceAssistantTools(run, state) }
}

const options = { context: undefined as never, messages: [], toolCallId: 'call_1' }

/** Go's feature decisions as the web sees them: `allowed` features pass, others are refused. */
function mockFeatures(
  t: TestContext,
  allowed: readonly string[],
  status = 200,
  posts: readonly Record<string, unknown>[] = []
) {
  const env = { ...process.env }
  process.env.PUBLISHING_API_URL = 'http://backend.test:8082'
  process.env.PUBLISHING_SERVICE_TOKEN = 'private-test-token'
  process.env.PLATFORM_CONTENT_DRAFTS = 'enabled'
  t.after(() => {
    for (const key of ['PUBLISHING_API_URL', 'PUBLISHING_SERVICE_TOKEN', 'PLATFORM_CONTENT_DRAFTS'])
      if (env[key] === undefined) delete process.env[key]
      else process.env[key] = env[key]
  })
  const asked: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const path = url.pathname
    if (path === '/v1/content-draft-posts') {
      asked.push(`posts ${url.searchParams.get('from')} ${url.searchParams.get('to')}`)
      return Response.json({ items: posts })
    }
    const feature = decodeURIComponent(path.replace('/v1/entitlements/features/', ''))
    asked.push(feature)
    if (status !== 200) return Response.json({ error: 'down' }, { status })
    return Response.json({
      allowed: allowed.includes(feature),
      currentPlan: 'free',
      feature,
      requiredPlan: 'pro',
    })
  })
  return { asked }
}

test('startWork offers a new visual holding the request, once', async () => {
  const { state, tools } = setup('creator')
  const ask = 'A hero for "Invoices" & #2 — été'
  assert.ok((await tools.startWork.execute({ ask, kind: 'visual' }, options)).ok)
  assert.ok((await tools.startWork.execute({ ask, kind: 'visual' }, options)).ok)
  assert.equal(state.links.length, 1)
  const [link] = state.links
  assert.equal(link?.label, 'Start this visual')
  const url = new URL(link?.href ?? '', 'http://shots.test')
  assert.equal(url.pathname, '/editor')
  assert.equal(url.searchParams.get('start'), 'new')
  assert.equal(url.searchParams.get('ask'), ask)
})

test('a viewer is offered no way to start work', async () => {
  const { state, tools } = setup('viewer')
  const result = await tools.startWork.execute({ ask: 'A hero', kind: 'visual' }, options)
  assert.equal(result.ok, false)
  assert.deepEqual(state.links, [])
})

test('startWork shares the four-button limit with offerLink', async () => {
  const { state, tools } = setup('creator')
  for (const href of ['/a', '/b', '/c', '/d']) {
    state.known.add(href)
    assert.ok((await tools.offerLink.execute({ href, label: href }, options)).ok)
  }
  const result = await tools.startWork.execute({ ask: 'A hero', kind: 'visual' }, options)
  assert.equal(result.ok, false)
  assert.equal(state.links.length, 4)
})

test('a viewer cannot draft a post', async () => {
  const { state, tools } = setup('viewer')
  const result = await tools.draftPost.execute({ text: 'We shipped invoices.' }, options)
  assert.equal(result.ok, false)
  assert.deepEqual(state.posts, [])
})

test('draftPost offers at most two posts, even when the model asks for three at once', async (t) => {
  const { asked } = mockFeatures(t, ['content:drafts'])
  const { state, tools } = setup('creator')
  const results = await Promise.all(
    ['One', 'Two', 'Three'].map((text) => tools.draftPost.execute({ text }, options))
  )
  assert.deepEqual(
    results.map((result) => result.ok),
    [true, true, false]
  )
  assert.equal(state.posts.length, 2)
  // One plan read answers the whole turn.
  assert.deepEqual(asked, ['content:drafts'])
})

test('a plan without posts gets no post', async (t) => {
  mockFeatures(t, [])
  const { state, tools } = setup('creator')
  assert.equal((await tools.draftPost.execute({ text: 'Hi' }, options)).ok, false)
  assert.deepEqual(state.posts, [])
})

test('startWork opens a campaign with what shipped, only where campaigns are on', async (t) => {
  mockFeatures(t, ['campaign:workflow'])
  const { state, tools } = setup('creator')
  const shipped = 'Invoices now send reminders & #follow-ups'
  assert.ok((await tools.startWork.execute({ kind: 'campaign', shipped }, options)).ok)
  const url = new URL(state.links[0]?.href ?? '', 'http://shots.test')
  assert.equal(state.links[0]?.label, 'Start this campaign')
  assert.equal(url.pathname, '/campaigns')
  assert.equal(url.searchParams.get('ship'), shipped)
  // workspace:paid is refused here, so no canvas button.
  const canvas = await tools.startWork.execute(
    { kind: 'canvas', recipe: 'product-launch' },
    options
  )
  assert.equal(canvas.ok, false)
  assert.equal(state.links.length, 1)
})

test('startWork refuses a campaign where campaigns are off', async (t) => {
  mockFeatures(t, ['workspace:paid'])
  const { state, tools } = setup('creator')
  const result = await tools.startWork.execute({ kind: 'campaign', shipped: 'Invoices' }, options)
  assert.equal(result.ok, false)
  assert.deepEqual(state.links, [])
})

test('an unreachable plan check fails the call instead of claiming the plan lacks it', async (t) => {
  mockFeatures(t, [], 500)
  const { tools } = setup('creator')
  const result = await tools.draftPost.execute({ text: 'Hi' }, options)
  assert.equal(result.ok, false)
  assert.notEqual((result as { error?: string }).error, 'Posts are not on for this workspace.')
})

/** A post on the calendar as Go returns it. */
function calendarPost(id: string, scheduledFor: string, status: string) {
  return {
    automations: [],
    calendarVersion: 1,
    caption: `Caption ${id}`,
    channelConnectionId: 'conn_1',
    createdAt: '2026-11-01T09:00:00Z',
    draftId: `draft_${id}`,
    draftTitle: `Draft ${id}`,
    id,
    metrics: null,
    metricsAt: null,
    naturalOffsetSeconds: null,
    platform: 'x',
    replies: 0,
    scheduleMode: null,
    scheduledFor,
    socialSetId: null,
    status,
    tagIds: [],
    threadProgress: { posted: 0, total: 1 },
    url: null,
    version: 1,
  }
}

test('listScheduledPosts reads the coming week, broken posts first, and offers each one', async (t) => {
  const soon = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString()
  const { asked } = mockFeatures(t, ['content:drafts'], 200, [
    { ...calendarPost('b', soon(26), 'SCHEDULED'), caption: '😀'.repeat(200) },
    calendarPost('a', soon(2), 'SCHEDULED'),
    calendarPost('c', soon(30), 'UNKNOWN_DELIVERY'),
    { ...calendarPost('d', soon(5), 'SCHEDULED'), campaignId: 'camp_1', draftId: '' },
  ])
  const { state, tools } = setup('viewer')
  const result = await tools.listScheduledPosts.execute({ days: 7, window: 'next' }, options)
  assert.ok(result.ok)
  assert.equal(result.total, 4)
  // What needs a check leads; the rest follow in time order, as the calendar names them.
  assert.deepEqual(
    result.posts.map((post) => [post.title, post.status]),
    [
      ['Draft c', 'Needs check'],
      ['Draft a', 'Scheduled'],
      ['Draft d', 'Scheduled'],
      ['Draft b', 'Scheduled'],
    ]
  )
  // A campaign's post opens on its campaign; a long caption is cut on whole characters.
  assert.equal(result.posts[2]?.href, '/campaigns/camp_1')
  assert.equal(result.posts[3]?.caption, '😀'.repeat(160))
  // The window starts now and spans seven days ahead.
  const [from, to] = (asked.find((entry) => entry.startsWith('posts ')) ?? '').split(' ').slice(1)
  assert.ok(Math.abs(Date.parse(from ?? '') - Date.now()) < 5_000)
  assert.equal(Date.parse(to ?? '') - Date.parse(from ?? ''), 7 * 86_400_000)
  assert.ok(Math.abs(Date.parse(result.now) - Date.now()) < 5_000)
  // A teammate's post text is data: only addresses the lookup returned can be offered.
  for (const post of result.posts) assert.ok(state.known.has(post.href))
})

test('listScheduledPosts looks back newest first, with an overdue post leading', async (t) => {
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString()
  const { asked } = mockFeatures(t, ['content:drafts'], 200, [
    calendarPost('old', ago(48), 'PUBLISHED'),
    calendarPost('new', ago(1), 'PUBLISHED'),
    calendarPost('late', ago(30), 'SCHEDULED'),
  ])
  const { tools } = setup('viewer')
  const result = await tools.listScheduledPosts.execute({ days: 3, window: 'last' }, options)
  assert.ok(result.ok)
  assert.deepEqual(
    result.posts.map((post) => [post.title, post.status]),
    [
      ['Draft late', 'Overdue'],
      ['Draft new', 'Published'],
      ['Draft old', 'Published'],
    ]
  )
  const to = (asked.find((entry) => entry.startsWith('posts ')) ?? '').split(' ')[2]
  assert.ok(Math.abs(Date.parse(to ?? '') - Date.now()) < 5_000)
})

test('listScheduledPosts says so, and reads nothing, when the workspace has no posts', async (t) => {
  const { asked } = mockFeatures(t, [])
  const { tools } = setup('viewer')
  const result = await tools.listScheduledPosts.execute({ days: 7, window: 'last' }, options)
  assert.equal(result.ok, false)
  assert.equal((result as { error?: string }).error, 'Posts are not on for this workspace.')
  assert.equal(
    asked.some((entry) => entry.startsWith('posts ')),
    false
  )
})

test('startWork opens only work a lookup found, with the change ready for its AI', async (t) => {
  mockFeatures(t, [])
  // Not found this turn, or not editable by an AI there (a post): refused.
  const refusing = setup('creator')
  refusing.state.known.add('/publish/d1')
  for (const href of ['/canvas/c1', '/publish/d1']) {
    const refused = await refusing.tools.startWork.execute(
      { ask: 'Bolder', href, kind: 'edit' },
      options
    )
    assert.equal(refused.ok, false, href)
  }
  assert.deepEqual(refusing.state.links, [])

  const { state, tools } = setup('creator')
  state.known.add('/canvas/c1')
  state.known.add('/editor?project=p1')
  for (const href of ['/canvas/c1', '/editor?project=p1'])
    assert.ok(
      (await tools.startWork.execute({ ask: 'Make it bolder', href, kind: 'edit' }, options)).ok
    )
  assert.deepEqual(
    state.links.map((link) => [link.label, link.href]),
    [
      ['Edit with AI', '/canvas/c1?ask=Make+it+bolder'],
      ['Edit with AI', '/editor?project=p1&ask=Make+it+bolder'],
    ]
  )
})

test('findPages gates campaign pages behind the workspace campaign entitlement', async (t) => {
  mockFeatures(t, [])
  const withoutCampaigns = setup('creator')
  const restricted = await withoutCampaigns.tools.findPages.execute({ query: 'campaign' }, options)
  assert.ok(restricted.ok)
  assert.equal(
    restricted.pages.some((page) => page.href.startsWith('/campaigns')),
    false
  )

  mockFeatures(t, ['campaign:workflow'])
  const withCampaigns = setup('creator')
  const allowed = await withCampaigns.tools.findPages.execute({ query: 'campaign' }, options)
  assert.ok(allowed.ok)
  assert.ok(allowed.pages.some((page) => page.href.startsWith('/campaigns')))
})

test('getIdealCustomerProfile, listBrandKits, and searchWorkspaceAssets expose workspace data', async (t) => {
  const env = { ...process.env }
  process.env.PUBLISHING_API_URL = 'http://backend.test:8082'
  process.env.PUBLISHING_SERVICE_TOKEN = 'private-test-token'
  t.after(() => {
    for (const key of ['PUBLISHING_API_URL', 'PUBLISHING_SERVICE_TOKEN'])
      if (env[key] === undefined) delete process.env[key]
      else process.env[key] = env[key]
  })
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (url.pathname === '/v1/ideal-customer-profile') {
      return Response.json({
        idealCustomerProfile: {
          createdAt: '2026-11-01T00:00:00Z',
          id: 'icp_1',
          lockedFields: [],
          organizationId: 'org_1',
          source: 'manual',
          summary: 'Product engineering leads shipping SaaS releases weekly.',
          updatedAt: '2026-11-02T00:00:00Z',
        },
      })
    }
    if (url.pathname === '/v1/brand-kits') {
      return Response.json({
        brandKits: [
          {
            createdAt: '2026-11-01T00:00:00Z',
            definition: {
              colors: { accent: '#6366f1', background: '#09090b', text: '#fafafa' },
              typography: { headingFamily: 'inter' },
            },
            id: 'kit_1',
            name: 'Primary Dark',
            status: 'PUBLISHED',
            version: 2,
          },
        ],
      })
    }
    if (url.pathname === '/v1/assets') {
      return Response.json({
        assets: [
          {
            altText: 'Product dashboard screenshot',
            classification: 'input',
            contentType: 'image/png',
            createdAt: '2026-11-02T00:00:00Z',
            fileName: 'dashboard.png',
            height: 900,
            id: 'asset_1',
            width: 1440,
          },
        ],
        nextCursor: null,
      })
    }
    return Response.json({ error: `unexpected path ${url.pathname}` }, { status: 404 })
  })

  const { state, tools } = setup('viewer')
  const icp = await tools.getIdealCustomerProfile.execute({}, options)
  assert.ok(icp.ok)
  assert.equal(icp.idealCustomerProfile?.id, 'icp_1')

  const kits = await tools.listBrandKits.execute({}, options)
  assert.ok(kits.ok)
  assert.equal(kits.brandKits.length, 1)
  assert.equal(kits.brandKits[0]?.name, 'Primary Dark')
  assert.equal(kits.brandKits[0]?.accent, '#6366f1')

  const assets = await tools.searchWorkspaceAssets.execute({ search: 'dashboard' }, options)
  assert.ok(assets.ok)
  assert.equal(assets.assets.length, 1)
  assert.equal(assets.assets[0]?.id, 'asset_1')
  assert.ok(state.known.has('/library'))
})

test('a viewer cannot draft a capture recipe, and a plan without posts reads no analytics', async (t) => {
  const { asked } = mockFeatures(t, [])
  const { tools } = setup('viewer')
  const recipe = await tools.proposeCaptureRecipe.execute({}, options)
  assert.equal(recipe.ok, false)
  const analytics = await tools.getSocialAnalyticsSummary.execute({ days: 28 }, options)
  assert.equal(analytics.ok, false)
  // The refused recipe asked the backend nothing.
  assert.deepEqual(asked, ['content:drafts'])
})

test('release details for a release the backend does not have are refused, with no link', async (t) => {
  mockFeatures(t, [])
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: 'Release not found.' }, { status: 404 })
  )
  const { state, tools } = setup('viewer')
  const result = await tools.getReleaseDetails.execute(
    { releaseId: '0f8b6f0e-6c55-4a53-9a0c-3d3f4b1c2a10' },
    options
  )
  assert.equal(result.ok, false)
  assert.ok(!state.known.has('/releases/0f8b6f0e-6c55-4a53-9a0c-3d3f4b1c2a10'))
})
