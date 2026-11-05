import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ScreenshotStudioBackendSDK } from '../../../packages/screenshot-studio-backend-sdk/src/index'
import {
  connectionAvailabilitySchema,
  connectionProviderSchema,
} from '../../../packages/screenshot-studio-backend-sdk/src/social-availability'
import { getSocialConnectionAvailabilityContract } from '../lib/api/contracts/social-availability'
import { providerComingSoon } from '../components/social-connections/availability'

const catalog = () =>
  connectionAvailabilitySchema.parse({
    version: 1,
    providers: connectionProviderSchema.options.map((provider) => ({
      provider,
      status: provider === 'substack' ? 'unsupported' : 'not_configured',
    })),
  })

test('availability rejects incomplete, ambiguous and credential-bearing catalogs', () => {
  const valid = catalog()
  for (const input of [
    { ...valid, version: 2 },
    { ...valid, providers: valid.providers.slice(1) },
    { ...valid, providers: valid.providers.map(() => valid.providers[0]) },
    { ...valid, providers: valid.providers.map((item) => ({ ...item, status: 'healthy' })) },
    { ...valid, providers: valid.providers.map((item) => ({ ...item, secret: 'private-canary' })) },
    { ...valid, appId: 'private-canary' },
  ])
    assert.equal(connectionAvailabilitySchema.safeParse(input).success, false)
  assert.equal(
    getSocialConnectionAvailabilityContract.query?.safeParse({ organizationId: 'foreign' }).success,
    false
  )
  assert.deepEqual(getSocialConnectionAvailabilityContract.access, {
    permission: 'workspace:update',
    feature: 'content:drafts',
    quota: 'api:write:minute',
  })
})

test('availability SDK uses the original session and validates the downstream response', async () => {
  let response: unknown = catalog()
  const client = new ScreenshotStudioBackendSDK(
    'https://backend.test',
    'fixture-service',
    {
      organizationId: 'original-workspace',
      requestId: 'request',
      sessionId: 'session',
      userId: 'user',
    },
    async (input, init) => {
      assert.equal(String(input), 'https://backend.test/v1/social-connection-availability')
      assert.equal(init?.method, 'GET')
      assert.equal(init?.body, undefined)
      assert.equal(new Headers(init?.headers).get('x-organization-id'), 'original-workspace')
      assert.equal(new Headers(init?.headers).get('x-session-id'), 'session')
      return Response.json(response)
    }
  )
  assert.deepEqual(await client.socialConnectionAvailability(), catalog())
  response = { version: 1, providers: [] }
  await assert.rejects(client.socialConnectionAvailability())
})

test('a platform is coming soon only when the catalog was read and refuses it', () => {
  const ready = (...available: string[]) => ({
    ...catalog(),
    providers: catalog().providers.map((item) => ({
      ...item,
      status: available.includes(item.provider) ? ('available' as const) : item.status,
    })),
  })
  assert.equal(providerComingSoon(ready('x'), 'threads'), true)
  assert.equal(providerComingSoon(ready('x', 'threads'), 'threads'), false)
  // An unread catalog leaves Connect in place; the start route checks again.
  assert.equal(providerComingSoon(undefined, 'threads'), false)
  // Mastodon's row connects through either its default or its custom-server flow.
  assert.equal(providerComingSoon(ready('mastodon-custom'), 'mastodon'), false)
})
