import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { OrganizationAccess } from '../lib/auth/access'
import { prepareContentDraftSchedule } from '../lib/tenant/content-drafts'

const access = {
  organizationId: 'org_test',
  principal: { display: 'test@example.test', kind: 'session', sessionId: 's', userId: 'u' },
  requestId: 'request_test',
} as OrganizationAccess

test('a schedule names a confirmed repeat only when the member confirmed one', async (t) => {
  process.env.PUBLISHING_API_URL = 'http://backend.test'
  process.env.PUBLISHING_SERVICE_TOKEN = 'token'
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname
    if (path === '/v1/content-drafts/draft_1')
      return Response.json({ body: [], channelText: {}, id: 'draft_1', version: 3 })
    if (path === '/v1/channel-connections') return Response.json({ items: [] })
    if (path === '/v1/social-sets') return Response.json({ items: [] })
    throw new Error(`unexpected backend call ${path}`)
  })
  const request = { channelConnectionIds: [], localTime: '2026-11-12T09:00', version: 3 }
  // An older backend refuses unknown fields, so an unconfirmed schedule must not name the field.
  for (const confirmDuplicate of [undefined, false]) {
    const plain = await prepareContentDraftSchedule(access, 'draft_1', {
      ...request,
      confirmDuplicate,
    })
    assert.ok(plain && !('confirmDuplicate' in JSON.parse(JSON.stringify(plain))))
  }
  const confirmed = await prepareContentDraftSchedule(access, 'draft_1', {
    ...request,
    confirmDuplicate: true,
  })
  assert.equal(confirmed?.confirmDuplicate, true)
})
