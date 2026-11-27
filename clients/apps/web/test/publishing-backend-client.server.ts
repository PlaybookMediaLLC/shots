import assert from 'node:assert/strict'
import { test } from 'node:test'
import { context, propagation, ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import type { OrganizationAccess } from '../lib/auth/access'
import {
  beginBackendSocialOAuth,
  completeBackendSocialOAuth,
  createBackendScheduledPost,
  listBackendScheduledPosts,
  PublishingBackendError,
} from '../lib/tenant/publishing-backend'

const access = {
  organizationId: 'org_test',
  principal: {
    display: 'test@example.test',
    kind: 'session',
    sessionId: 'session_test',
    userId: 'user_test',
  },
  requestId: 'request_test',
} as OrganizationAccess

test('the web client sends a scoped, authenticated request to the Ent backend', async (t) => {
  const oldURL = process.env.PUBLISHING_API_URL
  const oldToken = process.env.PUBLISHING_SERVICE_TOKEN
  process.env.PUBLISHING_API_URL = 'http://backend.test:8082'
  process.env.PUBLISHING_SERVICE_TOKEN = 'private-test-token'
  t.after(() => {
    if (oldURL === undefined) delete process.env.PUBLISHING_API_URL
    else process.env.PUBLISHING_API_URL = oldURL
    if (oldToken === undefined) delete process.env.PUBLISHING_SERVICE_TOKEN
    else process.env.PUBLISHING_SERVICE_TOKEN = oldToken
  })
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), 'http://backend.test:8082/v1/scheduled-posts')
    assert.equal(init?.method, 'POST')
    assert.equal(init?.cache, 'no-store')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-test-token')
    assert.equal(new Headers(init?.headers).get('x-organization-id'), 'org_test')
    assert.equal(new Headers(init?.headers).get('x-user-id'), 'user_test')
    assert.equal(new Headers(init?.headers).get('x-request-id'), 'request_test')
    assert.equal(new Headers(init?.headers).get('x-session-id'), 'session_test')
    assert.deepEqual(JSON.parse(String(init?.body)), {
      caption: 'canary',
      channelConnectionId: 'connection_test',
      idempotencyKey: 'once',
      scheduledFor: '2026-10-15T00:00:00.000Z',
      variantId: 'variant_test',
    })
    return Response.json({ created: true, scheduledPost: { id: 'post_test' } }, { status: 201 })
  })
  const result = await createBackendScheduledPost(access, {
    caption: 'canary',
    channelConnectionId: 'connection_test',
    idempotencyKey: 'once',
    scheduledFor: new Date('2026-10-15T00:00:00Z'),
    variantId: 'variant_test',
  })
  assert.equal(result.created, true)
  assert.equal(result.scheduledPost.id, 'post_test')
})

test('the web client rejects incomplete backend post data', async (t) => {
  const oldURL = process.env.PUBLISHING_API_URL
  const oldToken = process.env.PUBLISHING_SERVICE_TOKEN
  process.env.PUBLISHING_API_URL = 'http://backend.test:8082'
  process.env.PUBLISHING_SERVICE_TOKEN = 'private-test-token'
  t.after(() => {
    if (oldURL === undefined) delete process.env.PUBLISHING_API_URL
    else process.env.PUBLISHING_API_URL = oldURL
    if (oldToken === undefined) delete process.env.PUBLISHING_SERVICE_TOKEN
    else process.env.PUBLISHING_SERVICE_TOKEN = oldToken
  })
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ items: [{ id: 'post_without_connection' }] })
  )
  await assert.rejects(listBackendScheduledPosts(access, 50), (error) => {
    assert.ok(error instanceof PublishingBackendError)
    assert.equal(error.status, 503)
    return true
  })
})

test('OAuth begin and completion carry the same authenticated session to Ent', async (t) => {
  const oldURL = process.env.PUBLISHING_API_URL
  const oldToken = process.env.PUBLISHING_SERVICE_TOKEN
  process.env.PUBLISHING_API_URL = 'http://backend.test:8082'
  process.env.PUBLISHING_SERVICE_TOKEN = 'private-test-token'
  t.after(() => {
    if (oldURL === undefined) delete process.env.PUBLISHING_API_URL
    else process.env.PUBLISHING_API_URL = oldURL
    if (oldToken === undefined) delete process.env.PUBLISHING_SERVICE_TOKEN
    else process.env.PUBLISHING_SERVICE_TOKEN = oldToken
  })
  const paths: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    assert.equal(new Headers(init?.headers).get('x-session-id'), 'session_test')
    if (path.endsWith('/begin')) {
      assert.deepEqual(JSON.parse(String(init?.body)), { provider: 'x' })
      return Response.json(
        { url: 'https://api.x.com/oauth/authorize?oauth_token=state_test' },
        { status: 201 }
      )
    }
    assert.deepEqual(JSON.parse(String(init?.body)), {
      integrationId: 'destination_test',
      provider: 'x',
      state: 'state_test',
    })
    return Response.json({ id: 'connection_test' })
  })
  assert.equal(
    await beginBackendSocialOAuth(access, 'x'),
    'https://api.x.com/oauth/authorize?oauth_token=state_test'
  )
  await completeBackendSocialOAuth(access, 'x', 'state_test', 'destination_test')
  assert.deepEqual(paths, ['/v1/social-oauth/begin', '/v1/social-oauth/complete'])
})

test('an expired backend session is reported as unauthorized', async (t) => {
  const oldURL = process.env.PUBLISHING_API_URL
  const oldToken = process.env.PUBLISHING_SERVICE_TOKEN
  process.env.PUBLISHING_API_URL = 'http://backend.test:8082'
  process.env.PUBLISHING_SERVICE_TOKEN = 'private-test-token'
  t.after(() => {
    if (oldURL === undefined) delete process.env.PUBLISHING_API_URL
    else process.env.PUBLISHING_API_URL = oldURL
    if (oldToken === undefined) delete process.env.PUBLISHING_SERVICE_TOKEN
    else process.env.PUBLISHING_SERVICE_TOKEN = oldToken
  })
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: 'Session expired.' }, { status: 401 })
  )
  await assert.rejects(listBackendScheduledPosts(access, 50), (error) => {
    assert.ok(error instanceof PublishingBackendError)
    assert.equal(error.status, 401)
    return true
  })
})

test('the web client carries the active trace to the backend', async (t) => {
  const oldURL = process.env.PUBLISHING_API_URL
  const oldToken = process.env.PUBLISHING_SERVICE_TOKEN
  process.env.PUBLISHING_API_URL = 'http://backend.test:8082'
  process.env.PUBLISHING_SERVICE_TOKEN = 'private-test-token'
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  t.after(() => {
    context.disable()
    propagation.disable()
    if (oldURL === undefined) delete process.env.PUBLISHING_API_URL
    else process.env.PUBLISHING_API_URL = oldURL
    if (oldToken === undefined) delete process.env.PUBLISHING_SERVICE_TOKEN
    else process.env.PUBLISHING_SERVICE_TOKEN = oldToken
  })
  const traceId = '0af7651916cd43dd8448eb211c80319c'
  t.mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('traceparent'), `00-${traceId}-b7ad6b7169203331-01`)
    assert.equal(headers.get('authorization'), 'Bearer private-test-token')
    return Response.json({ items: [] })
  })
  const active = trace.setSpanContext(ROOT_CONTEXT, {
    traceId,
    spanId: 'b7ad6b7169203331',
    traceFlags: TraceFlags.SAMPLED,
  })
  assert.deepEqual(await context.with(active, () => listBackendScheduledPosts(access, 10)), [])
})

test('withDates converts *At ISO strings without mutating input or copying unchanged subtrees', async () => {
  const { withDates } = await import('../lib/backend/sdk')
  const staticPayload = { count: 3, nested: { label: 'unchanged' }, tags: ['a', 'b'] }
  assert.equal(withDates(staticPayload), staticPayload)

  const existingDate = new Date('2026-10-15T00:00:00.000Z')
  assert.equal(withDates(existingDate), existingDate)

  const unchangedChild = { id: 'child-1', title: 'Keep ref' }
  const input = {
    child: unchangedChild,
    createdAt: '2026-10-15T12:30:00.000Z',
    items: [unchangedChild, { updatedAt: '2026-10-16T00:00:00.000Z' }],
  }
  const result = withDates(input)
  assert.notEqual(result, input)
  assert.equal(typeof input.createdAt, 'string', 'original input must not be mutated')
  assert.ok(result.createdAt instanceof Date)
  assert.equal(result.createdAt.toISOString(), '2026-10-15T12:30:00.000Z')
  assert.equal(result.child, unchangedChild, 'unchanged sibling subtree keeps reference identity')
  assert.equal(result.items[0], unchangedChild, 'unchanged array item keeps reference identity')
  const secondItem = result.items[1]
  assert.ok('updatedAt' in secondItem && secondItem.updatedAt instanceof Date)
})
