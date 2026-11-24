import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BackendSDKError,
  ScreenshotStudioBackendSDK,
  createQualificationSchema,
  decideQualificationSchema,
  readinessRevisionSchema,
  selectReleaseSourcesSchema,
  mergeReleaseSchema,
  splitReleaseSchema,
} from '../../../packages/screenshot-studio-backend-sdk/src'

test('source selection validates exact observations and preserves paging, authority and receipts', async () => {
  const input = selectReleaseSourcesSchema.parse({
    releaseId: null,
    newRelease: { title: 'Human release', benefitStatement: 'Useful change' },
    expectedRevision: '0',
    sources: [
      {
        bindingId: 'binding-1',
        observationId: 'observation-1',
        expectedSequence: '9007199254740993',
      },
    ],
  })
  for (const invalid of [
    { ...input, releaseId: 'release-1' },
    { ...input, newRelease: null },
    { ...input, expectedRevision: '1' },
    { ...input, organizationId: 'foreign' },
    { ...input, sources: [...input.sources, ...input.sources] },
    { ...input, sources: [{ ...input.sources[0], expectedSequence: 1 }] },
    { ...input, sources: [{ ...input.sources[0], expectedSequence: '0' }] },
    {
      ...input,
      sources: Array.from({ length: 201 }, (_, i) => ({
        ...input.sources[0],
        bindingId: `binding-${i}`,
      })),
    },
  ])
    assert.equal(selectReleaseSourcesSchema.safeParse(invalid).success, false)
  const observation = {
    id: 'observation-1',
    sequence: '9007199254740993',
    providerEventId: 'delivery-1',
    sourceUpdatedAt: null,
    occurredAt: '2026-11-20T00:00:00Z',
    receivedAt: '2026-11-20T00:01:00Z',
    origin: 'LIVE',
    snapshot: {
      title: 'Provider facts',
      notes: '',
      url: null,
      repositoryName: 'acme/app',
      commit: null,
      environment: null,
      providerState: 'merged',
    },
  }
  const source = {
    id: 'binding-1',
    sourceAppId: 'source-1',
    sourceName: 'App',
    provider: 'github',
    kind: 'PULL_REQUEST',
    repositoryId: '1001',
    providerObjectId: '51',
    canonicalReleaseId: null,
    sequence: observation.sequence,
    available: true,
    needsResolution: true,
    selectionNeedsReview: true,
    current: observation,
    selected: null,
  }
  const calls: { url: URL; headers: Headers; body: unknown }[] = []
  const sdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'service-secret',
    { organizationId: 'org-1', requestId: 'request-1', sessionId: 'session-1', userId: 'user-1' },
    async (url, init) => {
      calls.push({
        url: new URL(String(url)),
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      if (String(url).includes('/selections'))
        return Response.json({
          created: true,
          releaseId: 'release-1',
          revision: '9007199254740994',
        })
      if (String(url).includes('/observations'))
        return Response.json({ source, items: [observation], nextCursor: '9007199254740993' })
      return Response.json({ items: [source], nextCursor: 'binding-1' })
    }
  )
  const page = await sdk.listReleaseSources({ releaseId: 'release-1', cursor: 'binding-2' })
  assert.equal(page.items[0].current?.sourceUpdatedAt, null)
  assert.equal(calls[0].url.searchParams.get('releaseId'), 'release-1')
  assert.equal(calls[0].url.searchParams.get('cursor'), 'binding-2')
  const history = await sdk.getReleaseSourceHistory('binding-1', '9007199254740994')
  assert.equal(history.items[0].sequence, '9007199254740993')
  assert.equal(calls[1].url.searchParams.get('cursor'), '9007199254740994')
  const result = await sdk.selectReleaseSources('choose-once', input)
  assert.equal(result.releaseId, 'release-1')
  assert.equal(result.revision, '9007199254740994')
  assert.deepEqual(calls[2].body, input)
  assert.equal(calls[2].headers.get('idempotency-key'), 'choose-once')
  for (const call of calls) assert.equal(call.headers.get('x-organization-id'), 'org-1')
})

test('qualification commands preserve scope, command key and decimal revisions', async () => {
  const calls: { path: string; headers: Headers; body: unknown }[] = []
  const sdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'service-secret',
    { organizationId: 'org-1', requestId: 'req-1', sessionId: 'session-1', userId: 'user-1' },
    async (url, init) => {
      calls.push({
        path: new URL(String(url)).pathname,
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      if (new URL(String(url)).pathname.endsWith('/revisions/history-1')) {
        return Response.json({
          id: 'history-1',
          version: '1',
          parentRevisionId: null,
          facts: input.facts,
          authorKind: 'session',
          authorId: 'user-1',
          createdAt: '2026-11-20T00:00:00Z',
          sourceAssets: [],
          sources: [],
          decision: null,
        })
      }
      return Response.json({
        created: true,
        revision: '9007199254740994',
        qualificationRevisionId: 'revision-1',
        decisionId: null,
      })
    }
  )
  const input = createQualificationSchema.parse({
    expectedRevision: '9007199254740993',
    facts: {
      ownerUserId: 'user-1',
      factReviewerUserId: 'user-1',
      rationale: null,
      rollout: 'UNKNOWN',
      availability: null,
      exclusions: null,
      eligibility: null,
      plannedAvailability: null,
      readyAt: null,
      humanBrief: null,
      humanBriefAuthorUserId: null,
      sourceUrls: [],
      sourceAssetIds: [],
      requirements: [],
    },
  })
  for (const [facts, message] of [
    [{ ...input.facts, humanBrief: 'Confirmed by the release owner.' }, 'Name the person'],
    [
      {
        ...input.facts,
        requirements: [
          { id: 'audience-1', kind: 'OTHER', label: null, materials: [], omissions: [] },
        ],
      },
      'Give each Other audience a name',
    ],
    [
      { ...input.facts, sourceUrls: ['https://example.test/facts', 'https://example.test/facts'] },
      'Use each source link once',
    ],
    [{ ...input.facts, sourceAssetIds: ['asset-1', 'asset-1'] }, 'Use each source file once'],
    [
      {
        ...input.facts,
        requirements: [
          { id: 'audience-1', kind: 'SALES', label: null, materials: [], omissions: [] },
          { id: 'audience-1', kind: 'CUSTOMER', label: null, materials: [], omissions: [] },
        ],
      },
      'Use a distinct ID for each audience',
    ],
    [
      {
        ...input.facts,
        requirements: [
          {
            id: 'audience-1',
            kind: 'SALES',
            label: null,
            materials: ['FAQ', 'FAQ'],
            omissions: [],
          },
        ],
      },
      'Choose each material once',
    ],
    [
      {
        ...input.facts,
        requirements: [
          {
            id: 'audience-1',
            kind: 'SALES',
            label: null,
            materials: ['FAQ'],
            omissions: [{ material: 'FAQ', reason: 'Already covered.' }],
          },
        ],
      },
      'Choose each material once',
    ],
    [
      {
        ...input.facts,
        requirements: [
          {
            id: 'audience-1',
            kind: 'SALES',
            label: null,
            materials: [],
            omissions: [
              { material: 'FAQ', reason: 'Already covered.' },
              { material: 'FAQ', reason: 'Repeated.' },
            ],
          },
        ],
      },
      'Choose each material once',
    ],
  ] as const) {
    const invalid = createQualificationSchema.safeParse({ ...input, facts })
    assert.equal(invalid.success, false)
    if (!invalid.success) assert.ok(invalid.error.issues[0].message.startsWith(message))
  }
  assert.equal(
    (await sdk.createQualificationRevision('release-1', 'same-command', input)).revision,
    '9007199254740994'
  )
  await sdk.decideReleaseQualification('release-1', 'decision-command', {
    expectedRevision: '9007199254740994',
    qualificationRevisionId: 'revision-1',
    decision: 'DEFERRED',
    reason: 'Awaiting facts.',
  })
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/v1/releases/release-1/qualification/revisions',
      '/v1/releases/release-1/qualification/decisions',
    ]
  )
  assert.deepEqual(calls[0].body, input)
  for (const decision of ['QUALIFIED', 'NO_COMMUNICATION', 'WITHDRAWN', 'REOPEN'] as const) {
    assert.equal(
      decideQualificationSchema.safeParse({
        expectedRevision: '1',
        qualificationRevisionId: 'revision-1',
        decision,
        reason: 'Reviewed',
        revisitAt: '2027-01-01T00:00:00Z',
      }).success,
      false
    )
  }
  assert.equal(
    decideQualificationSchema.safeParse({
      expectedRevision: '1',
      qualificationRevisionId: 'revision-1',
      decision: 'REOPEN',
      reason: 'Review the rollout again.',
    }).success,
    true
  )
  assert.equal(calls[0].headers.get('idempotency-key'), 'same-command')
  assert.equal(calls[1].headers.get('x-organization-id'), 'org-1')
  assert.equal(calls[1].headers.get('x-session-id'), 'session-1')
  for (const value of ['-1', '01', '9223372036854775808', '1.2'])
    assert.equal(readinessRevisionSchema.safeParse(value).success, false, value)
  await assert.rejects(sdk.createQualificationRevision('release-1', '', input))
  assert.equal(calls.length, 2, 'invalid command keys must fail before transport')
  assert.equal(
    createQualificationSchema.safeParse({ ...input, humanUserId: 'another-person' }).success,
    false
  )
  const historical = await sdk.getQualificationRevision('release-1', 'history-1')
  assert.equal(historical.id, 'history-1')
  assert.deepEqual(historical.sourceAssets, [])
  assert.equal(calls.at(-1)?.path, '/v1/releases/release-1/qualification/revisions/history-1')
  assert.equal(calls.at(-1)?.headers.get('x-organization-id'), 'org-1')
})

test('configuration SDK sends scoped requests to the backend', async () => {
  const requests: { path: string; body?: unknown; headers: Headers; method?: string }[] = []
  const sdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'service-secret',
    { organizationId: 'org-1', requestId: 'req-1', sessionId: 'session-1', userId: 'user-1' },
    async (input, init) => {
      const path = new URL(String(input)).pathname
      requests.push({
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: new Headers(init?.headers),
        method: init?.method,
      })
      if (path.endsWith('/brand-kits')) {
        return Response.json({ brandKits: [] })
      }
      return Response.json({ id: 'profile-1' })
    }
  )

  assert.deepEqual(await sdk.listBrandKits(), { brandKits: [] })
  await sdk.upsertBrandProfile({
    audience: 'Developers',
    preferredStyles: [],
    productDescription: 'A product',
    prohibitedTerms: [],
    socialHandles: {},
    tone: 'Concise',
  })
  await sdk.updateProductSurface('surface-1', { name: 'New name' })
  await sdk.deleteProductSurface('surface-1')
  assert.deepEqual(
    requests.map((request) => request.path),
    [
      '/v1/brand-kits',
      '/v1/brand-profile',
      '/v1/product-surfaces/surface-1',
      '/v1/product-surfaces/surface-1',
    ]
  )
  assert.deepEqual(
    requests.slice(2).map((request) => request.method),
    ['PATCH', 'DELETE']
  )
  assert.equal(requests[0].headers.get('authorization'), 'Bearer service-secret')
  assert.equal(requests[0].headers.get('x-session-id'), 'session-1')
  assert.equal(requests[0].headers.get('x-organization-id'), 'org-1')
  assert.deepEqual(requests[1].body, {
    audience: 'Developers',
    preferredStyles: [],
    productDescription: 'A product',
    prohibitedTerms: [],
    socialHandles: {},
    tone: 'Concise',
  })
})

test('workspace SDK distinguishes session and organization requests', async () => {
  const requests: { body?: unknown; path: string; headers: Headers; method?: string }[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    requests.push({
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      path,
      headers: new Headers(init?.headers),
      method: init?.method,
    })
    return Response.json(
      path.startsWith('/v1/workspace/invitations')
        ? {
            id: 'invite +1',
            organizationId: 'org-2',
            inviterId: 'user-1',
            email: 'test@example.test',
            role: 'viewer',
            status: 'pending',
            createdAt: '2026-10-21T00:00:00Z',
            expiresAt: '2026-10-28T00:00:00Z',
            organization: { name: 'Workspace' },
            user: { name: 'Owner', email: 'owner@example.test' },
          }
        : path === '/v1/workspaces'
          ? { workspaces: [] }
          : { updated: true }
    )
  }
  const sessionScope = {
    organizationId: '',
    requestId: 'req-1',
    sessionId: 'session-1',
    userId: 'user-1',
  }
  const sdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'secret',
    sessionScope,
    fetcher
  )
  assert.deepEqual(await sdk.listWorkspaces(), { workspaces: [] })
  await sdk.setActiveWorkspace('org-2')
  assert.deepEqual(
    requests.map(({ path, method }) => [path, method]),
    [
      ['/v1/workspaces', 'GET'],
      ['/v1/workspaces/active', 'POST'],
    ]
  )
  assert.equal(requests[0].headers.get('x-session-id'), 'session-1')
  assert.equal(requests[0].headers.get('x-organization-id'), '')

  const workspaceSDK = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'secret',
    { ...sessionScope, organizationId: 'org-2' },
    fetcher
  )
  await workspaceSDK.inviteWorkspaceMember({ email: 'test@example.test', role: 'viewer' })
  await workspaceSDK.resendWorkspaceInvitation('invite +1')
  await workspaceSDK.revokeWorkspaceInvitation('invite +1')
  await workspaceSDK.requestWorkspaceDeletion('Workspace')
  assert.deepEqual(
    requests.slice(2).map(({ path, method }) => [path, method]),
    [
      ['/v1/workspace/invitations', 'POST'],
      ['/v1/workspace/invitations/invite%20%2B1/resend', 'POST'],
      ['/v1/workspace/invitations/invite%20%2B1', 'DELETE'],
      ['/v1/workspace/deletion', 'POST'],
    ]
  )
  assert.deepEqual(requests[2].body, { email: 'test@example.test', role: 'viewer' })
  assert.equal(requests[2].headers.get('x-organization-id'), 'org-2')
})

test('bootstrap and audit SDK calls preserve scope, filters, and audit context', async () => {
  const requests: { url: URL; headers: Headers }[] = []
  const sdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'secret',
    { organizationId: 'org-1', requestId: 'req-1', sessionId: 'session-1', userId: 'user-1' },
    async (input, init) => {
      requests.push({ url: new URL(String(input)), headers: new Headers(init?.headers) })
      return Response.json({ items: [] })
    }
  )
  await sdk.getBootstrap()
  await sdk.getCurrentUser()
  await sdk.listAuditLogs(
    { limit: 2, outcome: 'FAILED', search: 'release', startDate: new Date('2026-10-14T12:00:00Z') },
    { ipHash: 'hash', userAgentSummary: 'test browser' }
  )
  assert.deepEqual(
    requests.map(({ url }) => url.pathname),
    ['/v1/bootstrap', '/v1/me', '/v1/audit-logs']
  )
  assert.equal(requests[2].url.searchParams.get('startDate'), '2026-10-14T12:00:00.000Z')
  assert.equal(requests[2].url.searchParams.get('outcome'), 'FAILED')
  assert.equal(requests[2].headers.get('x-organization-id'), 'org-1')
  assert.equal(requests[2].headers.get('x-audit-ip-hash'), 'hash')
  assert.equal(requests[2].headers.get('x-audit-user-agent-summary'), 'test browser')
})

test('access and media SDK methods retain scope and surface backend status', async () => {
  const requests: { body?: unknown; method?: string; url: URL }[] = []
  const sdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'secret',
    { organizationId: 'org-1', requestId: 'req-1', sessionId: 'session-1', userId: 'user-1' },
    async (input, init) => {
      const url = new URL(String(input))
      requests.push({
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        method: init?.method,
        url,
      })
      if (url.pathname.endsWith('/download-url')) {
        return Response.json({ error: 'Asset not found.' }, { status: 404 })
      }
      if (url.pathname === '/v1/access') {
        return Response.json({ organizationId: 'org-1', role: 'owner' })
      }
      return Response.json({ assets: [], nextCursor: null })
    }
  )

  assert.deepEqual(await sdk.getActiveAccess(), { organizationId: 'org-1', role: 'owner' })
  await sdk.verifySupportGrant('org-2', 'metadata:read')
  await sdk.listAssets({ cursor: 'asset-1', limit: 20 })
  await sdk.signAssetUpload({ bytes: 12, contentType: 'image/png', fileName: 'canary.png' })
  await assert.rejects(
    sdk.signAssetDownload('asset-1'),
    (error) => error instanceof BackendSDKError && error.status === 404
  )
  assert.equal(requests[1].url.searchParams.get('organizationId'), 'org-2')
  assert.equal(requests[1].url.searchParams.get('scope'), 'metadata:read')
  assert.equal(requests[2].url.searchParams.get('cursor'), 'asset-1')
  assert.equal(requests[2].url.searchParams.get('limit'), '20')
  assert.equal(requests[3].method, 'POST')
  assert.deepEqual(requests[3].body, {
    bytes: 12,
    contentType: 'image/png',
    fileName: 'canary.png',
  })
})

test('release SDK preserves nullable updates, idempotency, and tenant scope', async () => {
  const requests: { body?: unknown; headers: Headers; method?: string; url: URL }[] = []
  const sdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'secret',
    { organizationId: 'org-1', requestId: 'req-1', sessionId: 'session-1', userId: 'user-1' },
    async (input, init) => {
      requests.push({
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: new Headers(init?.headers),
        method: init?.method,
        url: new URL(String(input)),
      })
      return Response.json({ releases: [] })
    }
  )
  await sdk.listReleases(25)
  await sdk.createRelease({
    title: 'Launch',
    benefitStatement: '',
    sourceUrls: ['https://example.test'],
    idempotencyKey: 'key-1',
  })
  await sdk.updateRelease('release-1', { audience: null, productSurfaceId: null })
  assert.equal(requests[0].url.searchParams.get('limit'), '25')
  assert.deepEqual(
    requests.slice(1).map(({ method }) => method),
    ['POST', 'PATCH']
  )
  assert.equal(requests[1].url.pathname, '/v1/releases')
  assert.equal(requests[2].url.pathname, '/v1/releases/release-1')
  assert.deepEqual(requests[2].body, { audience: null, productSurfaceId: null })
  assert.equal(requests[1].headers.get('x-organization-id'), 'org-1')
  assert.deepEqual(requests[1].body, {
    title: 'Launch',
    benefitStatement: '',
    sourceUrls: ['https://example.test'],
    idempotencyKey: 'key-1',
  })
})

test('generated asset SDK sends bytes and metadata without JSON encoding', async () => {
  const requests: { body?: BodyInit | null; headers: Headers; path: string }[] = []
  const sdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'secret',
    { organizationId: 'org-1', requestId: 'req-1', sessionId: 'session-1', userId: 'user-1' },
    async (input, init) => {
      requests.push({
        body: init?.body,
        headers: new Headers(init?.headers),
        path: new URL(String(input)).pathname,
      })
      return Response.json({
        id: 'asset-1',
        mediaType: 'image/png',
        objectKey: 'org/org-1/derived/asset-1/1/render.png',
      })
    }
  )
  await sdk.storeGeneratedAsset({
    body: Uint8Array.from([137, 80, 78, 71]),
    classification: 'derived',
    contentType: 'image/png',
    fileName: 'render.png',
    height: 1,
    parentAssetId: 'asset-parent',
    width: 1,
  })
  await sdk.consumeWorkspaceQuota('generation:monthly', 2)
  assert.equal(requests[0].path, '/v1/assets/generated')
  assert.deepEqual(Array.from(new Uint8Array(requests[0].body as ArrayBuffer)), [137, 80, 78, 71])
  assert.equal(requests[0].headers.get('content-type'), 'image/png')
  assert.equal(requests[0].headers.get('x-parent-asset-id'), 'asset-parent')
  assert.equal(requests[0].headers.get('x-asset-width'), '1')
  assert.equal(requests[1].path, '/v1/quotas/consume')
  assert.deepEqual(JSON.parse(String(requests[1].body)), { amount: 2, quota: 'generation:monthly' })
})

test('campaign discovery preserves bounds, cursor, release and recovery identity', async () => {
  const requests: URL[] = []
  const sdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'service-secret',
    { organizationId: 'org-1', requestId: 'req-1', sessionId: 'session-1', userId: 'user-1' },
    async (input, init) => {
      requests.push(new URL(String(input)))
      assert.equal(new Headers(init?.headers).get('x-organization-id'), 'org-1')
      return Response.json({ campaigns: [] })
    }
  )
  await sdk.listCampaigns()
  await sdk.listCampaigns({ limit: 11, releaseId: 'release-1', cursor: 'campaign-2' })
  await sdk.listCampaigns({ limit: 1, idempotencyKey: 'onboarding:first-campaign:v1' })
  await sdk.listCampaigns({ limit: 4, search: 'Launch + Q&A', sort: 'updated' })
  await sdk.listReleases(4, 'Launch + Q&A')
  assert.equal(requests[0].search, '')
  assert.deepEqual(Object.fromEntries(requests[1].searchParams), {
    limit: '11',
    releaseId: 'release-1',
    cursor: 'campaign-2',
  })
  assert.deepEqual(Object.fromEntries(requests[2].searchParams), {
    limit: '1',
    idempotencyKey: 'onboarding:first-campaign:v1',
  })
  assert.deepEqual(Object.fromEntries(requests[3].searchParams), {
    limit: '4',
    search: 'Launch + Q&A',
    sort: 'updated',
  })
  assert.deepEqual(Object.fromEntries(requests[4].searchParams), {
    limit: '4',
    search: 'Launch + Q&A',
  })
})

test('campaign, design, creative, and entitlement SDK calls hit their backend routes', async () => {
  const requests: { body?: unknown; method?: string; path: string }[] = []
  const sdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'service-secret',
    { organizationId: 'org-1', requestId: 'req-1', sessionId: 'session-1', userId: 'user-1' },
    async (input, init) => {
      requests.push({
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        method: init?.method,
        path: new URL(String(input)).pathname,
      })
      return Response.json({})
    }
  )

  await sdk.listCampaigns()
  await sdk.transitionCampaign('campaign-1', 'READY_FOR_REVIEW')
  await sdk.decideCampaignPosts('campaign-1', { decision: 'approve', postIds: ['post-1'] })
  await sdk.scheduleCampaignPost('campaign-1', 'post-1', { channelConnectionId: 'conn-1' })
  await sdk.listCampaignDesigns('campaign-1')
  await sdk.updateDesignDocument('design-1', { pages: [] })
  await sdk.setDesignRender('design-1', 'asset-1', null)
  await sdk.decideCreativeVariant('variant-1', { status: 'APPROVED' })
  await sdk.getFeatureDecision('asset:delete')

  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.path}`),
    [
      'GET /v1/campaigns',
      'POST /v1/campaigns/campaign-1/transition',
      'POST /v1/campaigns/campaign-1/posts/decide',
      'POST /v1/campaigns/campaign-1/posts/post-1/schedule',
      'GET /v1/campaigns/campaign-1/designs',
      'PUT /v1/designs/design-1/document',
      'PUT /v1/designs/design-1/render',
      'POST /v1/creative-variants/variant-1/decision',
      'GET /v1/entitlements/features/asset%3Adelete',
    ]
  )
  assert.deepEqual(requests[1].body, { status: 'READY_FOR_REVIEW' })
  assert.deepEqual(requests[5].body, { document: { pages: [] } })
  assert.deepEqual(requests[6].body, { assetId: 'asset-1', renderKey: null })
})

test('release grouping validates disjoint bounded selections and preserves command receipts', async () => {
  const merge = mergeReleaseSchema.parse({
    expectedRevision: '9007199254740992',
    sources: [{ releaseId: 'release-old', expectedRevision: '1' }],
    bindingIds: ['binding-1'],
    reason: 'Shared rollout',
  })
  const split = splitReleaseSchema.parse({
    expectedRevision: '9007199254740992',
    groups: [
      {
        bindingIds: ['binding-1'],
        newRelease: { title: 'Separate rollout', benefitStatement: 'Useful outcome' },
      },
    ],
    reason: 'Independent rollout',
  })
  for (const invalid of [
    { ...merge, expectedRevision: 1 },
    { ...merge, expectedRevision: '01' },
    { ...merge, sources: [] },
    { ...merge, sources: [...merge.sources, ...merge.sources] },
    {
      ...merge,
      sources: Array.from({ length: 20 }, (_, i) => ({
        releaseId: `release-${i}`,
        expectedRevision: '1',
      })),
    },
    { ...merge, bindingIds: ['binding-1', 'binding-1'] },
    { ...merge, bindingIds: Array.from({ length: 201 }, (_, i) => `binding-${i}`) },
    { ...merge, reason: ' ' },
    { ...merge, reason: 'bad\0reason' },
    { ...merge, humanUserId: 'forged' },
  ])
    assert.equal(mergeReleaseSchema.safeParse(invalid).success, false)
  for (const invalid of [
    { ...split, groups: [] },
    { ...split, groups: [...split.groups, ...split.groups] },
    { ...split, groups: [{ ...split.groups[0], bindingIds: [] }] },
    {
      ...split,
      groups: [
        {
          ...split.groups[0],
          newRelease: { ...split.groups[0].newRelease, ownerUserId: 'forged' },
        },
      ],
    },
    {
      ...split,
      groups: Array.from({ length: 21 }, (_, i) => ({
        ...split.groups[0],
        bindingIds: [`binding-${i}`],
      })),
    },
  ])
    assert.equal(splitReleaseSchema.safeParse(invalid).success, false)
  const calls: { url: URL; headers: Headers; body: unknown }[] = []
  const sdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'service-secret',
    { organizationId: 'org-1', requestId: 'request-1', sessionId: 'session-1', userId: 'user-1' },
    async (url, init) => {
      calls.push({
        url: new URL(String(url)),
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return Response.json(
        String(url).includes('/lineage')
          ? { items: [], nextCursor: null }
          : {
              created: false,
              releaseId: 'release-1',
              releases: [
                { releaseId: 'release-1', revision: '9007199254740993' },
                { releaseId: 'release-new', revision: '1' },
              ],
              lineageIds: ['lineage-1'],
            }
      )
    }
  )
  const merged = await sdk.mergeRelease('release-1', 'same-merge', merge)
  const separated = await sdk.splitRelease('release-1', 'same-split', split)
  await sdk.getReleaseLineage('release-1', 'history-1')
  assert.equal(merged.created, false)
  assert.equal(merged.releases[0].revision, '9007199254740993')
  assert.deepEqual(separated.lineageIds, ['lineage-1'])
  assert.deepEqual(
    calls.slice(0, 2).map((call) => call.body),
    [merge, split]
  )
  assert.deepEqual(
    calls.slice(0, 2).map((call) => call.headers.get('idempotency-key')),
    ['same-merge', 'same-split']
  )
  assert.deepEqual(
    calls.map((call) => call.url.pathname),
    [
      '/v1/releases/release-1/qualification/merge',
      '/v1/releases/release-1/qualification/split',
      '/v1/releases/release-1/qualification/lineage',
    ]
  )
  assert.equal(calls[2].url.searchParams.get('cursor'), 'history-1')
  for (const call of calls) {
    assert.equal(call.headers.get('x-organization-id'), 'org-1')
    assert.equal(call.headers.get('x-session-id'), 'session-1')
  }
})
