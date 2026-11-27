import assert from 'node:assert/strict'
import test from 'node:test'
import { createShotsClient } from './index.js'

test('createShotsClient attaches bounded AbortSignal timeout and respects caller signal', async () => {
  let capturedSignal: AbortSignal | undefined
  const controller = new AbortController()
  const client = createShotsClient({
    apiKey: 'ss_test',
    baseUrl: 'https://shots.example',
    fetch: async (_input, init) => {
      capturedSignal = init?.signal ?? undefined
      return Response.json({ items: [] })
    },
    signal: controller.signal,
    timeoutMs: 5_000,
  })
  await client.GET('/api/v1/campaigns')
  assert.ok(capturedSignal instanceof AbortSignal)
  assert.equal(capturedSignal.aborted, false)
  controller.abort(new Error('cancelled'))
  assert.equal(capturedSignal.aborted, true)
})

test('createShotsClient fires timeoutMs and ignores non-finite timeoutMs', async () => {
  let timedOutSignal: AbortSignal | undefined
  const slowClient = createShotsClient({
    apiKey: 'ss_test',
    baseUrl: 'https://shots.example',
    fetch: async (_input, init) => {
      timedOutSignal = init?.signal ?? undefined
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 500)
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(init.signal?.reason)
        })
      })
      return Response.json({ items: [] })
    },
    timeoutMs: 25,
  })
  await assert.rejects(slowClient.GET('/api/v1/campaigns'))
  assert.equal(timedOutSignal?.aborted, true)

  const unboundedClient = createShotsClient({
    apiKey: 'ss_test',
    baseUrl: 'https://shots.example',
    fetch: async (input, init) => {
      const sig = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      assert.equal(sig?.aborted ?? false, false)
      return Response.json({ items: [] })
    },
    timeoutMs: Number.NaN,
  })
  const res = await unboundedClient.GET('/api/v1/campaigns')
  assert.deepEqual(res.data, { items: [] })
})
