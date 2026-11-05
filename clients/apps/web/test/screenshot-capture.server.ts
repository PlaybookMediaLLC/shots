import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import sharp from 'sharp'
import type { OrganizationAccess } from '../lib/auth/access'
import { captureScreenshot, getScreenshotFailure } from '../lib/screenshot-service'
import { captureProductSurface, queueSignedInCaptureAt } from '../lib/tenant/product-surfaces'

const input = {
  colorScheme: 'light',
  deviceType: 'desktop',
  forceRefresh: false,
  url: 'https://example.com',
} as const

function blank(): Promise<Buffer> {
  return sharp({ create: { background: '#000', channels: 3, height: 36, width: 64 } })
    .png()
    .toBuffer()
}

function rendered(): Promise<Buffer> {
  const pixels = Buffer.alloc(64 * 36 * 3, 0).map((_, index) => index % 251)
  return sharp(pixels, { raw: { channels: 3, height: 36, width: 64 } })
    .png()
    .toBuffer()
}

/** Serves each capture in turn and records the capture-service requests. */
function stubCaptures(t: TestContext, images: Buffer[]): string[] {
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    if (String(url).includes('screenshot=true')) {
      requests.push(String(url))
      const screenshot = { url: `https://cdn.example.com/${requests.length}.png` }
      return Response.json({ data: { screenshot }, status: 'success' })
    }
    return new Response(new Uint8Array(images.shift()!), {
      headers: { 'content-type': 'image/png' },
    })
  })
  return requests
}

test('a blank capture is retried once after the page settles', async (t) => {
  const page = await rendered()
  const requests = stubCaptures(t, [await blank(), page])
  const capture = await captureScreenshot(input)
  assert.equal(capture.screenshot, page.toString('base64'))
  assert.equal(requests.length, 2)
  assert.doesNotMatch(requests[0]!, /waitForTimeout/)
  assert.match(requests[1]!, /waitForTimeout=4000/)
})

test('a page that stays blank fails as a 502 without caching anything', async (t) => {
  stubCaptures(t, [await blank(), await blank()])
  const error = await captureScreenshot(input).catch((caught: unknown) => caught)
  assert.equal(getScreenshotFailure(error).status, 502)
})

test('a rendered page is captured once', async (t) => {
  const requests = stubCaptures(t, [await rendered()])
  await captureScreenshot(input)
  assert.equal(requests.length, 1)
})

test('every caller is refused a private page before the service is asked', async (t) => {
  const requests = stubCaptures(t, [])
  for (const url of [
    'http://127.0.0.1/admin',
    'https://10.1.2.3/',
    'http://169.254.169.254/latest',
  ]) {
    const error = await captureScreenshot({ ...input, url }).catch((caught: unknown) => caught)
    assert.equal(getScreenshotFailure(error).status, 400)
  }
  assert.equal(requests.length, 0)
})

const access = {
  organizationId: 'org_test',
  principal: { display: 'ada', kind: 'session', sessionId: 'session_test', userId: 'user_test' },
  requestId: 'request_test',
} as OrganizationAccess

/** Answers as the backend would for a surface with an active signed-in recipe. */
function stubSignedInSurface(t: TestContext, available: boolean, job: () => Response): string[] {
  process.env.PUBLISHING_API_URL = 'http://backend.test'
  process.env.PUBLISHING_SERVICE_TOKEN = 'private-test-token'
  t.after(() => {
    delete process.env.PUBLISHING_API_URL
    delete process.env.PUBLISHING_SERVICE_TOKEN
  })
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(url))
    requests.push(`${init?.method} ${pathname} ${init?.body ?? ''}`.trim())
    if (pathname === '/v1/product-surfaces') {
      return Response.json({
        productSurfaces: [
          {
            createdAt: '2026-11-04T12:00:00Z',
            id: 'surface_1',
            updatedAt: '2026-11-04T12:00:00Z',
            url: 'https://app.example.com/dashboard',
          },
        ],
      })
    }
    if (pathname === '/v1/capture') {
      const recipes = [{ id: 'recipe_1', status: 'ACTIVE', surfaceId: 'surface_1' }]
      return Response.json({ available, connections: [], jobs: [], recipes })
    }
    return job()
  })
  return requests
}

test('a page behind a sign-in queues a capture job, never a public screenshot', async (t) => {
  const job = { id: 'job_1', phase: 'QUEUED' }
  const requests = stubSignedInSurface(t, true, () => Response.json({ job }, { status: 202 }))
  assert.deepEqual(await captureProductSurface(access, 'surface_1'), { job })
  assert.equal(
    requests.at(-1),
    'POST /v1/capture/recipes/recipe_1/jobs {"test":false,"source":"manual"}'
  )
  assert.equal(requests.length, 3)
})

test('an agent capture of a signed-in page keeps the run that asked for it', async (t) => {
  const job = { id: 'job_1', phase: 'QUEUED' }
  const requests = stubSignedInSurface(t, true, () => Response.json({ job }, { status: 202 }))
  await captureProductSurface(access, 'surface_1', { source: 'agent', sourceId: 'run_1' })
  assert.equal(
    requests.at(-1),
    'POST /v1/capture/recipes/recipe_1/jobs {"test":false,"source":"agent","sourceId":"run_1"}'
  )
})

test('a URL-based capture of a signed-in page queues a job instead of a screenshot', async (t) => {
  const url = 'https://app.example.com/dashboard'
  const job = { id: 'job_1', phase: 'QUEUED' }
  const requests = stubSignedInSurface(t, true, () => Response.json({ job }, { status: 202 }))
  assert.equal(await queueSignedInCaptureAt(access, url, 'run_1'), 'queued')
  assert.equal(
    requests.at(-1),
    'POST /v1/capture/recipes/recipe_1/jobs {"test":false,"source":"agent","sourceId":"run_1"}'
  )
  t.mock.restoreAll()

  // Another page is an ordinary public one, and no job starts.
  const other = stubSignedInSurface(t, true, () => Response.json({ job }, { status: 202 }))
  assert.equal(await queueSignedInCaptureAt(access, 'https://app.example.com/', 'run_1'), null)
  assert.equal(other.length, 2)
  t.mock.restoreAll()

  // A revoked or unconfigured sign-in reports that, and still takes no screenshot.
  const conflict = () => Response.json({ error: 'publishing resource' }, { status: 409 })
  stubSignedInSurface(t, true, conflict)
  assert.equal(await queueSignedInCaptureAt(access, url, 'run_1'), 'unavailable')
  t.mock.restoreAll()
  const off = stubSignedInSurface(t, false, conflict)
  assert.equal(await queueSignedInCaptureAt(access, url, 'run_1'), 'unavailable')
  assert.equal(off.length, 2)
})

test('a signed-in page fails plainly when it cannot queue, without a public screenshot', async (t) => {
  const job = () => Response.json({ error: 'publishing resource' }, { status: 409 })
  const requests = stubSignedInSurface(t, true, job)
  const revoked = await captureProductSurface(access, 'surface_1')
  assert.ok(revoked && 'failure' in revoked)
  assert.match(revoked.failure.message, /revoked/)
  assert.doesNotMatch(revoked.failure.message, /publishing resource/)
  assert.equal(requests.length, 3)
  t.mock.restoreAll()

  const off = stubSignedInSurface(t, false, job)
  const unavailable = await captureProductSurface(access, 'surface_1')
  assert.ok(unavailable && 'failure' in unavailable)
  assert.match(unavailable.failure.message, /not configured/)
  assert.equal(off.length, 2)
})

test('a surface from another workspace is not captured at all', async (t) => {
  const requests = stubSignedInSurface(t, true, () => Response.json({}))
  assert.equal(await captureProductSurface(access, 'surface_other'), null)
  assert.equal(requests.length, 1)
})
