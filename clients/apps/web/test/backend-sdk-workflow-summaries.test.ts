import assert from 'node:assert/strict'
import test from 'node:test'
import { ScreenshotStudioBackendSDK } from '../../../packages/screenshot-studio-backend-sdk/src'

test('recent runs request six summaries and history retains filters and tenant scope', async () => {
  const requests: URL[] = []
  const sdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'service-secret',
    {
      organizationId: 'org-1',
      requestId: 'req-1',
      sessionId: 'session-1',
      userId: 'user-1',
    },
    async (input, init) => {
      requests.push(new URL(String(input)))
      assert.equal(new Headers(init?.headers).get('x-organization-id'), 'org-1')
      return Response.json({ items: [] })
    }
  )
  await sdk.listReleaseAutomationRunSummaries({ mode: 'automation' }, 6)
  await sdk.listReleaseAutomationRunSummaries({
    status: 'skipped',
    before: 'run-2',
    definitionId: 'workflow-1',
  })
  assert.deepEqual(Object.fromEntries(requests[0].searchParams), {
    summary: 'true',
    limit: '6',
    mode: 'automation',
  })
  assert.deepEqual(Object.fromEntries(requests[1].searchParams), {
    summary: 'true',
    limit: '50',
    status: 'skipped',
    before: 'run-2',
    definitionId: 'workflow-1',
  })
  assert.ok(requests.every((url) => url.pathname === '/v1/release-automation/runs'))
})
