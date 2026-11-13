import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { test, type TestContext } from 'node:test'
import type { OrganizationAccess } from '../lib/auth/access'

import { saveSenjaKey, senjaKey } from '../lib/content-drafts/senja'
import { sealCredentials } from '../lib/integrations/crypto'
import { listIntegrations } from '../lib/integrations/server'
import { storeFetchedAsset } from '../lib/tenant/assets'

// The key is read when credentials are sealed, so it can be set after the imports.
process.env.INTEGRATION_ENCRYPTION_KEY ??= randomBytes(32).toString('base64')

const access = {
  organizationId: 'org_test',
  principal: { display: 'owner@example.test', kind: 'session', sessionId: 's', userId: 'u' },
  requestId: 'request_test',
} as OrganizationAccess

type Call = { body: unknown; headers: Headers; method: string; url: URL }

/** Go's API and storage as the web server sees them, keeping every request. */
function mock(t: TestContext, answer: (call: Call) => Response | Promise<Response>) {
  const previous = {
    PUBLISHING_API_URL: process.env.PUBLISHING_API_URL,
    PUBLISHING_SERVICE_TOKEN: process.env.PUBLISHING_SERVICE_TOKEN,
  }
  process.env.PUBLISHING_API_URL = 'http://backend.test:8082'
  process.env.PUBLISHING_SERVICE_TOKEN = 'private-test-token'
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  const calls: Call[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const raw = init?.body
    const call = {
      body: typeof raw === 'string' ? JSON.parse(raw) : raw,
      headers: new Headers(init?.headers),
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
    }
    calls.push(call)
    return answer(call)
  })
  return calls
}

const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const asset = { id: 'casset000000001' }

test('a fetched file up to 16 MB goes in one write-once PUT, checked by its digest', async (t) => {
  const bytes = new Uint8Array([1, 2, 3])
  const calls = mock(t, ({ url }) =>
    url.hostname === 'storage.test'
      ? new Response(null, { status: 200 })
      : url.pathname === '/v1/assets/upload-url'
        ? Response.json({ asset, uploadUrl: 'https://storage.test/one' })
        : Response.json({ asset })
  )
  const stored = await storeFetchedAsset(access, {
    bytes,
    contentType: 'video/mp4',
    fileName: 'senja-Ada.mp4',
  })
  assert.equal(stored?.id, asset.id)
  const [reserve, put, complete] = calls
  assert.deepEqual(reserve!.body, {
    bytes: 3,
    classification: 'input',
    contentType: 'video/mp4',
    fileName: 'senja-Ada.mp4',
    sha256: hex(bytes),
  })
  assert.equal(put!.headers.get('if-none-match'), '*')
  assert.equal(put!.headers.get('content-type'), 'video/mp4')
  assert.equal(complete!.url.pathname, `/v1/assets/${asset.id}/complete`)
  assert.deepEqual(complete!.body, { sha256: hex(bytes) })
})

test('a larger file goes in parts, each with its digest, and a failed part is sent again', async (t) => {
  const partBytes = 16 * 1024 * 1024
  const bytes = new Uint8Array(partBytes + 1).fill(7)
  let failures = 1
  const calls = mock(t, ({ body, url }) => {
    if (url.hostname === 'storage.test') {
      // Storage drops the second part once.
      if (url.pathname === '/part2' && failures-- > 0) return new Response(null, { status: 500 })
      return new Response(null, { status: 200 })
    }
    if (url.pathname === '/v1/assets/upload-url')
      return Response.json({ asset, uploadUrl: '', multipart: { partBytes, parts: 2 } })
    if (url.pathname.endsWith('/upload-parts')) {
      const [number] = (body as { parts: number[] }).parts
      return Response.json({
        partBytes,
        parts: 2,
        uploaded: [],
        urls: [{ number, url: `https://storage.test/part${number}` }],
      })
    }
    return Response.json({ asset })
  })
  const stored = await storeFetchedAsset(access, {
    bytes,
    contentType: 'video/mp4',
    fileName: 'big.mp4',
  })
  assert.equal(stored?.id, asset.id)
  const reserve = calls[0]!.body as Record<string, unknown>
  assert.equal(reserve.multipart, true)
  assert.equal('sha256' in reserve, false, 'a large file is checked part by part')
  assert.equal(calls.filter((call) => call.url.pathname === '/part2').length, 2)
  assert.deepEqual(calls.at(-1)!.body, {
    partSha256: [hex(bytes.subarray(0, partBytes)), hex(bytes.subarray(partBytes))],
  })
})

test('storage that does not take the file leaves no asset', async (t) => {
  mock(t, ({ url }) =>
    url.hostname === 'storage.test'
      ? new Response(null, { status: 403 })
      : Response.json({ asset, uploadUrl: 'https://storage.test/one' })
  )
  assert.equal(
    await storeFetchedAsset(access, {
      bytes: new Uint8Array([1]),
      contentType: 'video/mp4',
      fileName: 'a.mp4',
    }),
    null
  )
})

test('a Senja key is checked with Senja first, saved sealed, read back, and kept out of delivery', async (t) => {
  const integration = (provider: string) => ({
    createdAt: '2026-11-13T09:00:00Z',
    displayName: provider,
    externalId: provider.toLowerCase(),
    id: `ci_${provider.toLowerCase()}`,
    provider,
    scopes: [],
    tokenExpiresAt: null,
  })
  const calls = mock(t, ({ url }) => {
    if (url.pathname === '/v1/integrations')
      return Response.json({ integrations: [integration('SENJA'), integration('NOTION')] })
    if (url.pathname === '/v1/integrations/ci_senja/credentials')
      return Response.json({
        ...integration('SENJA'),
        encryptedCredentials: sealCredentials({ accessToken: 'senja-key-1234' }),
      })
    return Response.json(integration('SENJA'))
  })
  const refused: typeof fetch = async () => new Response('', { status: 401 })
  await assert.rejects(saveSenjaKey(access, 'wrong-key-1234', refused), /refused the API key/)
  assert.equal(
    calls.some((call) => call.method === 'POST'),
    false,
    'a refused key is never saved'
  )
  const accepted: typeof fetch = async () => Response.json({ testimonials: [] })
  await saveSenjaKey(access, 'senja-key-1234', accepted)
  const saved = calls.find((call) => call.method === 'POST')!.body as Record<string, string>
  assert.equal(saved.provider, 'SENJA')
  assert.equal(saved.externalId, 'senja')
  assert.equal(JSON.stringify(saved).includes('senja-key-1234'), false, 'the key is sealed')
  assert.equal(await senjaKey(access), 'senja-key-1234')
  assert.deepEqual(
    (await listIntegrations(access)).map((item) => item.provider),
    ['NOTION']
  )
})
