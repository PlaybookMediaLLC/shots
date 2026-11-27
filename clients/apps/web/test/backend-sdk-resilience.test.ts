import assert from 'node:assert/strict'
import test from 'node:test'
import { BackendSDKError, ScreenshotStudioBackendSDK } from 'screenshot-studio-backend-sdk'

const scope = {
  organizationId: 'org-1',
  requestId: 'req-1',
  sessionId: 'session-1',
  userId: 'user-1',
}

test('ScreenshotStudioBackendSDK attaches AbortSignal, retries idempotent GET on 503, and never retries POST', async () => {
  let getAttempts = 0
  let sawSignal = false
  const sdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'secret',
    scope,
    async (_input, init) => {
      if (init?.signal) sawSignal = true
      if ((init?.method ?? 'GET') === 'GET') {
        getAttempts++
        if (getAttempts < 3) {
          return new Response(JSON.stringify({ error: 'busy' }), { status: 503 })
        }
        return Response.json({ items: [] })
      }
      return new Response(JSON.stringify({ error: 'busy' }), { status: 503 })
    }
  )

  const list = await sdk.listScheduledPosts(10)
  assert.deepEqual(list, { items: [] })
  assert.equal(getAttempts, 3)
  assert.equal(sawSignal, true)

  let postAttempts = 0
  const postSdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'secret',
    scope,
    async () => {
      postAttempts++
      return new Response(JSON.stringify({ error: 'busy' }), { status: 503 })
    }
  )
  await assert.rejects(
    postSdk.signAssetUpload({ bytes: 12, contentType: 'image/png', fileName: 'a.png' }),
    (err) => err instanceof BackendSDKError && err.status === 503
  )
  assert.equal(postAttempts, 1)
})

test('ScreenshotStudioBackendSDK preserves transport cause on BackendSDKError', async () => {
  const rootCause = new TypeError('socket closed')
  const sdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'secret',
    scope,
    async () => {
      throw rootCause
    }
  )
  await assert.rejects(
    sdk.signAssetUpload({ bytes: 12, contentType: 'image/png', fileName: 'a.png' }),
    (err) => err instanceof BackendSDKError && err.status === 503 && err.cause === rootCause
  )
})

test('ScreenshotStudioBackendSDK retries transport errors, never retries TimeoutError or 4xx, and passes through 304/416', async () => {
  let transportAttempts = 0
  const retrySdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'secret',
    scope,
    async () => {
      transportAttempts++
      if (transportAttempts < 2) throw new TypeError('connection reset')
      return Response.json({ items: [] })
    }
  )
  const list = await retrySdk.listScheduledPosts(5)
  assert.deepEqual(list, { items: [] })
  assert.equal(transportAttempts, 2)

  let timeoutAttempts = 0
  const timeoutSdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'secret',
    scope,
    async () => {
      timeoutAttempts++
      throw new DOMException('timed out', 'TimeoutError')
    }
  )
  await assert.rejects(
    timeoutSdk.listScheduledPosts(5),
    (err) => err instanceof BackendSDKError && err.status === 503
  )
  assert.equal(timeoutAttempts, 1)

  let notFoundAttempts = 0
  const notFoundSdk = new ScreenshotStudioBackendSDK(
    'https://backend.example',
    'secret',
    scope,
    async () => {
      notFoundAttempts++
      return new Response(JSON.stringify({ error: 'missing' }), { status: 404 })
    }
  )
  await assert.rejects(
    notFoundSdk.listScheduledPosts(5),
    (err) => err instanceof BackendSDKError && err.status === 404
  )
  assert.equal(notFoundAttempts, 1)

  for (const status of [304, 416] as const) {
    const streamSdk = new ScreenshotStudioBackendSDK(
      'https://backend.example',
      'secret',
      scope,
      async (_input, init) => {
        const headers = new Headers(init?.headers)
        assert.equal(headers.get('if-none-match'), '"etag-1"')
        return new Response(null, { status })
      }
    )
    const res = await streamSdk.readAssetDownload('asset-1', 'tok-1', undefined, '"etag-1"')
    assert.equal(res.status, status)
  }
})
