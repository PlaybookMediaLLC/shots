import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BackendSDKError,
  ScreenshotStudioBackendSDK,
} from '../../../packages/screenshot-studio-backend-sdk/src'

test('content draft SDK methods call the backend draft routes', async () => {
  const requests: { body?: unknown; method?: string; url: URL }[] = []
  const sdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'service-secret',
    { organizationId: 'org-1', requestId: 'req-1', sessionId: 'session-1', userId: 'user-1' },
    async (input, init) => {
      const url = new URL(String(input))
      requests.push({
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        method: init?.method,
        url,
      })
      if (init?.method === 'PATCH') {
        return Response.json(
          { code: 'content_draft_version_conflict', currentVersion: 4, error: 'stale' },
          { status: 409 }
        )
      }
      return Response.json(
        url.pathname.endsWith('content-drafts') ? { items: [], nextCursor: null } : { id: 'd1' }
      )
    }
  )

  await sdk.listContentDrafts({ limit: 10, status: 'scheduled' })
  await sdk.createContentDraft({ body: [], title: 'Launch' })
  await sdk.getContentDraft('d1')
  await assert.rejects(
    sdk.updateContentDraft('d1', { baseVersion: 3, title: 'New' }),
    (error) => error instanceof BackendSDKError && error.status === 409
  )
  await sdk.deleteContentDraft('d1')
  await sdk.reviewContentDraft('d1', { action: 'approve', version: 4 })

  assert.deepEqual(
    requests.map(({ method, url }) => `${method ?? 'GET'} ${url.pathname}${url.search}`),
    [
      'GET /v1/content-drafts?limit=10&status=scheduled',
      'POST /v1/content-drafts',
      'GET /v1/content-drafts/d1',
      'PATCH /v1/content-drafts/d1',
      'DELETE /v1/content-drafts/d1',
      'POST /v1/content-drafts/d1/review',
    ]
  )
  assert.deepEqual(requests[1].body, { body: [], title: 'Launch' })
  assert.deepEqual(requests[3].body, { baseVersion: 3, title: 'New' })
  assert.deepEqual(requests[5].body, { action: 'approve', version: 4 })
})
