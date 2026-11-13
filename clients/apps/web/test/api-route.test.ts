import assert from 'node:assert/strict'
import test from 'node:test'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { defineContract, timestampSchema } from '@/lib/api/contract'
import * as notificationContracts from '@/lib/api/contracts/notifications'
import { platformErrorBodySchema } from '@/lib/api/platform-errors'
import { type Authenticate, errorResponse, route, routeLogEntrySchema } from '@/lib/api/route'

const caller = { organizationId: 'org_1', principal: { kind: 'session' } }

const allow: Authenticate<typeof caller> = async () => caller

function authorizationError(status: 401 | 403) {
  return Object.assign(new Error('Authentication is required.'), {
    name: 'AuthorizationError',
    status,
  })
}

const deny: Authenticate<typeof caller> = async () => {
  throw authorizationError(401)
}

const itemContract = defineContract({
  body: z.object({ count: z.number().int() }),
  method: 'POST',
  name: 'items.create',
  output: z.object({ createdAt: timestampSchema, id: z.string() }),
  params: z.object({ listId: z.string() }),
  path: '/api/v1/lists/{listId}/items',
  status: 201,
  summary: 'Create an item',
})

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('https://studio.test/api/v1/lists/list_1/items', {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  })
}

const context = { params: Promise.resolve({ listId: 'list_1' }) }

test('cross-origin cookie writes cannot reach authentication or the mutation handler', async (t) => {
  captureLogs(t)
  const auth = t.mock.fn(allow)
  const handler = t.mock.fn(async () => ({ createdAt: new Date(), id: 'x' }))
  const response = await route(itemContract, { auth, handler })(
    post(
      { count: 1 },
      {
        cookie: 'better-auth.session_token=test',
        origin: 'https://attacker.example',
      }
    ),
    context
  )
  assert.equal(response.status, 403)
  assert.equal(auth.mock.callCount(), 0)
  assert.equal(handler.mock.callCount(), 0)
})

function captureLogs(t: test.TestContext) {
  const info = t.mock.method(console, 'info', () => undefined)
  const error = t.mock.method(console, 'error', () => undefined)
  return {
    errors: () => error.mock.calls.length,
    lines: () =>
      info.mock.calls.map((call) => routeLogEntrySchema.parse(JSON.parse(call.arguments[0]))),
  }
}

test('auth runs before input validation', async (t) => {
  captureLogs(t)
  const handler = t.mock.fn(async () => ({ createdAt: new Date(), id: 'x' }))
  const response = await route(itemContract, { auth: deny, handler })(post('not json'), context)
  assert.equal(response.status, 401)
  assert.equal(handler.mock.callCount(), 0)
})

test('a requested-scope authenticator reads the raw input once, before validation', async (t) => {
  captureLogs(t)
  const contract = defineContract({
    body: z.object({ organizationId: z.string() }),
    method: 'POST',
    name: 'audit.change',
    output: z.object({ ok: z.boolean() }),
    path: '/api/audit',
    summary: 'Change',
  })
  const auth: Authenticate<typeof caller> = async ({ raw }) => {
    const { body } = await raw()
    assert.deepEqual(body, { organizationId: 'org_1' })
    return caller
  }
  const response = await route(contract, {
    auth,
    handler: async ({ body }) => ({ ok: body.organizationId === 'org_1' }),
  })(post({ organizationId: 'org_1' }), context)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
})

test('invalid input returns the documented envelope', async (t) => {
  captureLogs(t)
  const handler = async () => ({ createdAt: new Date(), id: 'x' })
  const response = await route(itemContract, { auth: allow, handler })(
    post({ count: 'two' }),
    context
  )
  assert.equal(response.status, 400)
  const body = platformErrorBodySchema.strict().parse(await response.json())
  assert.equal(body.code, 'invalid_request')
})

test('output is parsed: unknown keys are stripped and codecs encode', async (t) => {
  captureLogs(t)
  const createdAt = new Date('2026-10-15T10:00:00.000Z')
  const response = await route(itemContract, {
    auth: allow,
    handler: async ({ body, params }) =>
      Object.assign({ createdAt, id: `${params.listId}:${body.count}` }, { secret: 'leak' }),
  })(post({ count: 2 }), context)
  assert.equal(response.status, 201)
  assert.deepEqual(await response.json(), { createdAt: createdAt.toISOString(), id: 'list_1:2' })
})

test('an output that breaks the contract is a logged 500, never a 400', async (t) => {
  const logs = captureLogs(t)
  const response = await route(itemContract, {
    auth: allow,
    handler: async () => ({ createdAt: 'yesterday', id: 1 }) as never,
  })(post({ count: 1 }), context)
  assert.equal(response.status, 500)
  assert.equal(platformErrorBodySchema.parse(await response.json()).code, 'internal_error')
  assert.equal(logs.errors(), 1)
})

test('unknown errors are logged 500s; domain errors keep their status', async (t) => {
  const logs = captureLogs(t)
  const crash = await route(itemContract, {
    auth: allow,
    handler: async () => {
      throw new Error('boom')
    },
  })(post({ count: 1 }), context)
  assert.equal(crash.status, 500)
  assert.equal(logs.errors(), 1)

  const conflict = await route(itemContract, {
    auth: allow,
    handler: async () => {
      throw Object.assign(new Error('Changed.'), { name: 'WorkspaceError', status: 409 })
    },
  })(post({ count: 1 }), context)
  assert.equal(conflict.status, 409)
  assert.equal(platformErrorBodySchema.parse(await conflict.json()).code, 'conflict')
  assert.equal(logs.errors(), 1)
})

test('request ids are echoed when well formed and replaced otherwise', async (t) => {
  captureLogs(t)
  const handler = async () => ({ createdAt: new Date(), id: 'x' })
  const run = (requestId: string) =>
    route(itemContract, { auth: allow, handler })(
      post({ count: 1 }, { 'x-request-id': requestId }),
      context
    )

  assert.equal((await run('req-123')).headers.get('x-request-id'), 'req-123')
  for (const invalid of ['bad id with spaces', 'x'.repeat(129)]) {
    const replaced = (await run(invalid)).headers.get('x-request-id')
    assert.ok(replaced && replaced !== invalid)
    assert.match(replaced, /^[\w.:-]+$/)
  }
})

test('responses default to private no-store unless the handler sets caching', async (t) => {
  captureLogs(t)
  const plain = await route(itemContract, {
    auth: allow,
    handler: async () => ({ createdAt: new Date(), id: 'x' }),
  })(post({ count: 1 }), context)
  assert.equal(plain.headers.get('cache-control'), 'private, no-store')

  const cached = await route(itemContract, {
    auth: allow,
    handler: async () => new Response('ok', { headers: { 'cache-control': 'public, max-age=60' } }),
  })(post({ count: 1 }), context)
  assert.equal(cached.headers.get('cache-control'), 'public, max-age=60')
})

test('handlers can reject with the envelope and pick the success status', async (t) => {
  captureLogs(t)
  const missing = await route(itemContract, {
    auth: allow,
    handler: async () => errorResponse(404, 'Item not found.'),
  })(post({ count: 1 }), context)
  assert.equal(missing.status, 404)
  assert.equal(platformErrorBodySchema.parse(await missing.json()).code, 'not_found')

  const replayed = await route(itemContract, {
    auth: allow,
    handler: async () => ({ createdAt: new Date(), id: 'existing' }),
    status: (output) => (output.id === 'existing' ? 200 : 201),
  })(post({ count: 1 }), context)
  assert.equal(replayed.status, 200)
})

test('a 204 contract sends no body', async (t) => {
  captureLogs(t)
  const contract = defineContract({
    method: 'DELETE',
    name: 'items.delete',
    output: z.undefined(),
    path: '/api/items',
    status: 204,
    summary: 'Delete',
  })
  const response = await route(contract, { auth: allow, handler: async () => undefined })(
    new NextRequest('https://studio.test/api/items', { method: 'DELETE' }),
    context
  )
  assert.equal(response.status, 204)
  assert.equal(await response.text(), '')
})

test('every notification route is a shell route, so no API key or MCP agent reaches it', () => {
  const contracts = Object.values(notificationContracts).flatMap((value) =>
    typeof value === 'object' && value !== null && 'method' in value && 'name' in value
      ? [{ name: String(value.name), shell: 'shell' in value ? value.shell : undefined }]
      : []
  )
  assert.ok(contracts.length >= 17, `found ${contracts.length} notification contracts`)
  for (const contract of contracts) assert.equal(contract.shell, true, contract.name)
})

test('shell routes refuse API keys before auth runs and log the shell event', async (t) => {
  const logs = captureLogs(t)
  const contract = defineContract({
    method: 'GET',
    name: 'bootstrap',
    output: z.object({ ok: z.boolean() }),
    path: '/api/v1/bootstrap',
    shell: true,
    summary: 'Bootstrap',
  })
  const auth = t.mock.fn(allow)
  const response = await route(contract, { auth, handler: async () => ({ ok: true }) })(
    new NextRequest('https://studio.test/api/v1/bootstrap', {
      headers: { 'x-api-key': 'key', 'x-playbook-client': 'CLI' },
    }),
    context
  )
  assert.equal(response.status, 403)
  assert.equal(auth.mock.callCount(), 0)
  const [line] = logs.lines()
  assert.equal(line.event, 'playbook.shell_request')
  assert.equal(line.client, 'cli')
  assert.equal(line.status, 403)
})

test('the log line names the route, caller kind, and organization only', async (t) => {
  const logs = captureLogs(t)
  await route(itemContract, {
    auth: allow,
    handler: async () => ({ createdAt: new Date(), id: 'x' }),
  })(post({ count: 1 }, { 'user-agent': 'secret-agent' }), context)
  const [line] = logs.lines()
  assert.equal(line.event, 'playbook.api_request')
  assert.equal(line.route, 'items.create')
  assert.equal(line.principal, 'session')
  assert.equal(line.organizationId, 'org_1')
  assert.equal(line.client, 'unknown')
  assert.doesNotMatch(JSON.stringify(line), /secret-agent/)
})

test('routes without dynamic segments work when Next.js passes no params', async (t) => {
  captureLogs(t)
  const contract = defineContract({
    method: 'GET',
    name: 'me',
    output: z.object({ ok: z.boolean() }),
    path: '/api/v1/me',
    summary: 'Me',
  })
  const handler = route(contract, { auth: allow, handler: async () => ({ ok: true }) })
  const request = new NextRequest('https://studio.test/api/v1/me')
  for (const nextContext of [undefined, { params: Promise.resolve(undefined) }]) {
    const response = await handler(request, nextContext as never)
    assert.equal(response.status, 200)
  }
})
