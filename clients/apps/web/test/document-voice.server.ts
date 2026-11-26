import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { OrganizationAccess } from '../lib/auth/access'
import { documentVoice } from '../lib/ai/document/chat'

const access = {
  organizationId: 'org_test',
  principal: { display: 'test@example.test', kind: 'session', sessionId: 's', userId: 'u' },
  requestId: 'request_test',
} as OrganizationAccess

const draftVoice = {
  formatting: '',
  platformGuidance: 'Short.',
  prohibitedPhrases: [],
  terminology: [],
  tone: 'Draft voice',
}
const brandVoice = {
  formatting: '',
  platformGuidance: '',
  prohibitedPhrases: [],
  terminology: [],
  tone: 'Workspace voice',
}

/** Answers the backend calls the voice lookup makes, recording each path. */
function backend(t: import('node:test').TestContext, draftStatus: number) {
  process.env.PUBLISHING_API_URL = 'http://backend.test'
  process.env.PUBLISHING_SERVICE_TOKEN = 'token'
  const paths: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input))
    paths.push(url.pathname + url.search)
    if (url.pathname === '/v1/content-drafts/clf0f1a2c3d4e5f6/writing-context')
      return draftStatus === 200
        ? Response.json(draftVoice)
        : Response.json({ error: 'not found' }, { status: draftStatus })
    if (url.pathname === '/v1/launch/brand')
      return Response.json({ kit: null, profile: null, voice: brandVoice })
    throw new Error(`unexpected backend call ${url.pathname}`)
  })
  return paths
}

test('the document editor writes in the draft voice for the platform being edited', async (t) => {
  const paths = backend(t, 200)
  const voice = await documentVoice(access, { channel: 'linkedin', draftId: 'clf0f1a2c3d4e5f6' })
  assert.equal(voice?.tone, 'Draft voice')
  assert.deepEqual(paths, ['/v1/content-drafts/clf0f1a2c3d4e5f6/writing-context?channel=linkedin'])
})

test('a draft the caller cannot see, or no draft, falls back to the workspace voice', async (t) => {
  const paths = backend(t, 404)
  assert.equal(
    (await documentVoice(access, { channel: 'x', draftId: 'clf0f1a2c3d4e5f6' }))?.tone,
    'Workspace voice'
  )
  assert.equal((await documentVoice(access, {}))?.tone, 'Workspace voice')
  assert.deepEqual(paths, [
    '/v1/content-drafts/clf0f1a2c3d4e5f6/writing-context?channel=x',
    '/v1/launch/brand',
    '/v1/launch/brand',
  ])
})
