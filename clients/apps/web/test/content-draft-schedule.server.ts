import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { OrganizationAccess } from '../lib/auth/access'
import { scheduleContentDraftContract } from '../lib/api/contracts/content-drafts'
import { scheduleContentDraft } from '../lib/tenant/content-drafts'
import { readVersions, withOptions } from '../lib/write/versions'

const access = {
  organizationId: 'org_test',
  principal: {
    display: 'publisher@example.test',
    kind: 'session',
    sessionId: 'session_test',
    userId: 'user_test',
  },
  requestId: 'request_test',
} as OrganizationAccess

const account = 'cx00000000000001'
const approved = {
  plugAtLikes: 25,
  plugMetric: 'likes' as const,
  plugText: 'The approved reply.',
}
// The stored draft at version 3, as Go returns it: the text a reviewer approved.
const stored = {
  article: null,
  body: [{ children: [{ text: 'The approved text.' }], type: 'p' }],
  channelConnectionIds: [account],
  createdAt: '2026-11-01T09:00:00Z',
  id: 'draft00000000001',
  kind: 'standard',
  platformVersions: withOptions(readVersions(undefined), 'x', { automation: approved }),
  target: null,
  updatedAt: '2026-11-01T09:00:00Z',
  version: 3,
}

test('a draft schedule carries the stored draft text, never text from its caller', async (t) => {
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
  let sent: unknown
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    if (path === `/v1/content-drafts/${stored.id}`) return Response.json(stored)
    if (path === '/v1/channel-connections')
      return Response.json({ items: [{ id: account, platform: 'x' }] })
    if (path === '/v1/social-sets') return Response.json({ items: [] })
    assert.equal(path, `/v1/content-drafts/${stored.id}/schedule`)
    sent = JSON.parse(String(init?.body))
    return Response.json({ created: true, draft: stored, posts: [] }, { status: 201 })
  })
  // A publisher sends the approved version with text of their own, in every
  // shape a schedule used to take it: the route's contract and the web's
  // serializer leave none of it in what Go receives.
  const body = scheduleContentDraftContract.body.parse({
    caption: 'Unapproved caption.',
    channelConnectionIds: [account],
    options: {
      [account]: {
        autoActions: { plugAtLikes: 1, plugText: 'Unapproved reply.' },
        poll: { durationMinutes: 60, options: ['Unapproved', 'Poll'] },
      },
    },
    publishNow: true,
    targets: [{ caption: 'Unapproved caption.', channelConnectionId: account }],
    version: 3,
  })
  const result = await scheduleContentDraft(access, stored.id, body)
  assert.equal(result?.created, true)
  assert.doesNotMatch(JSON.stringify(sent), /Unapproved/)
  assert.deepEqual(sent, {
    publishNow: true,
    targets: [
      {
        assetIds: [],
        autoActions: approved,
        caption: 'The approved text.',
        channelConnectionId: account,
      },
    ],
    version: 3,
  })
})
