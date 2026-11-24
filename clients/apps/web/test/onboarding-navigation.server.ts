import assert from 'node:assert/strict'
import test from 'node:test'
import { pathAfterPlan } from '@/lib/onboarding/next-step'
import { startFirstCampaign } from '@/lib/onboarding/first-campaign'
import type { OrganizationAccess, TenantContext } from '@/lib/auth/access'

const tenant: TenantContext = {
  organizationId: 'org-1',
  requestId: 'req-1',
  principal: { kind: 'session', userId: 'user-1', sessionId: 'session-1', display: 'Test member' },
}

test('post-plan navigation distinguishes an absent profile from unavailable setup', async (t) => {
  const previous = {
    url: process.env.PUBLISHING_API_URL,
    token: process.env.PUBLISHING_SERVICE_TOKEN,
  }
  process.env.PUBLISHING_API_URL = 'https://backend.test'
  process.env.PUBLISHING_SERVICE_TOKEN = 'test-service-token'
  t.after(() => {
    if (previous.url === undefined) delete process.env.PUBLISHING_API_URL
    else process.env.PUBLISHING_API_URL = previous.url
    if (previous.token === undefined) delete process.env.PUBLISHING_SERVICE_TOKEN
    else process.env.PUBLISHING_SERVICE_TOKEN = previous.token
  })
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async (_input: string | URL | Request, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get('x-organization-id'), tenant.organizationId)
      return Response.json({ productProfile: null })
    }
  )
  assert.equal(await pathAfterPlan(tenant), '/onboarding/product')
  fetch.mock.mockImplementation(async () =>
    Response.json({
      productProfile: {
        id: 'profile-1',
        organizationId: tenant.organizationId,
        name: 'Product',
        url: 'https://product.test',
        summary: 'Product context',
        audience: '',
        problem: '',
        capabilities: [],
        proofPoints: [],
        competitors: [],
        pricingNote: '',
        provenance: {},
        createdAt: '2026-11-20T00:00:00Z',
        updatedAt: '2026-11-20T00:00:00Z',
      },
    })
  )
  assert.equal(await pathAfterPlan(tenant), '/')
  for (const status of [403, 500, 503]) {
    fetch.mock.mockImplementation(async () => Response.json({ error: 'Unavailable' }, { status }))
    assert.equal(await pathAfterPlan(tenant), '/home?setup=unavailable')
  }
  fetch.mock.mockImplementation(async () => {
    throw new Error('Connection lost')
  })
  assert.equal(await pathAfterPlan(tenant), '/home?setup=unavailable')
})

test('first campaign resumes after a lost creation response at each persistence boundary', async (t) => {
  const previous = {
    url: process.env.PUBLISHING_API_URL,
    token: process.env.PUBLISHING_SERVICE_TOKEN,
  }
  process.env.PUBLISHING_API_URL = 'https://backend.test'
  process.env.PUBLISHING_SERVICE_TOKEN = 'test-service-token'
  t.after(() => {
    if (previous.url === undefined) delete process.env.PUBLISHING_API_URL
    else process.env.PUBLISHING_API_URL = previous.url
    if (previous.token === undefined) delete process.env.PUBLISHING_SERVICE_TOKEN
    else process.env.PUBLISHING_SERVICE_TOKEN = previous.token
  })
  const access: OrganizationAccess = {
    deniedPermissions: [],
    organizationId: 'org-1',
    requestId: 'req-1',
    role: 'owner',
    principal: { kind: 'session', userId: 'user-1', sessionId: 'session-1', display: 'Owner' },
  }
  for (const boundary of ['product-surfaces', 'releases', 'campaigns']) {
    await t.test(boundary, async (t) => {
      const saved = new Map<string, Record<string, unknown>>()
      let loseResponse = true
      let writes = 0
      t.mock.method(
        globalThis,
        'fetch',
        async (input: string | URL | Request, init?: RequestInit) => {
          assert.equal(new Headers(init?.headers).get('x-organization-id'), access.organizationId)
          const url = new URL(String(input))
          const collection = url.pathname.split('/').at(-1)!
          if (init?.method === 'POST') {
            writes += 1
            const body = JSON.parse(String(init.body)) as Record<string, unknown>
            if (collection !== 'product-surfaces')
              assert.equal(body.idempotencyKey, 'onboarding:first-campaign:v1')
            const created = !saved.has(collection)
            if (created) saved.set(collection, { id: `${collection}-1`, ...body })
            if (collection === boundary && loseResponse) {
              loseResponse = false
              throw new Error('Response lost after commit')
            }
            const item = saved.get(collection)!
            return Response.json(
              collection === 'releases' ? { created, release: item } : { ...item, created }
            )
          }
          if (collection === 'campaigns') {
            assert.equal(url.searchParams.get('idempotencyKey'), 'onboarding:first-campaign:v1')
            assert.equal(url.searchParams.get('limit'), '1')
            return Response.json({
              campaigns: saved.has(collection) ? [saved.get(collection)] : [],
            })
          }
          if (collection === 'product-surfaces')
            return Response.json({
              productSurfaces: saved.has(collection) ? [saved.get(collection)] : [],
            })
          if (collection === 'product-profile')
            return Response.json({
              productProfile: {
                name: 'Product',
                url: 'https://product.test',
                summary: 'Useful',
                audience: '',
                problem: '',
                capabilities: [],
                proofPoints: [],
                competitors: [],
                pricingNote: '',
                provenance: {},
                createdAt: '2026-11-20T00:00:00Z',
                updatedAt: '2026-11-20T00:00:00Z',
              },
            })
          throw new Error(`Unexpected request ${url.pathname}`)
        }
      )
      await assert.rejects(startFirstCampaign(access, []), /Publishing backend is unavailable/)
      assert.equal(loseResponse, false, 'the failure happened after the selected write committed')
      const recovered = await startFirstCampaign(access, [])
      assert.equal(recovered.campaignId, 'campaigns-1')
      assert.equal(recovered.created, boundary !== 'campaigns')
      assert.equal(saved.size, 3)
      const completedWrites = writes
      assert.deepEqual(await startFirstCampaign(access, []), { ...recovered, created: false })
      assert.equal(writes, completedWrites, 'completed setup is read without creating more work')
    })
  }
})
