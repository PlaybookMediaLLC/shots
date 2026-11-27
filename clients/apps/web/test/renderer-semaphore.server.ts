import assert from 'node:assert/strict'
import test from 'node:test'
import { RenderSemaphore } from '@/lib/design/renderer'

test('RenderSemaphore enforces concurrency cap under burst contention and releases permits on rejection', async () => {
  const semaphore = new RenderSemaphore(() => 2)
  let inFlight = 0
  let peak = 0
  const releaseQueue: Array<() => void> = []

  const runTask = (shouldFail = false) =>
    semaphore.run(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise<void>((resolve) => releaseQueue.push(resolve))
      try {
        if (shouldFail) throw new Error('render failed')
        return 'ok'
      } finally {
        inFlight -= 1
      }
    })

  const tasks = [runTask(false), runTask(true), runTask(false), runTask(false), runTask(false)]
  const settledPromise = Promise.allSettled(tasks)
  // Wait one microtask turn so the first 2 enter and the rest queue.
  await Promise.resolve()
  assert.equal(inFlight, 2)
  assert.equal(releaseQueue.length, 2)

  while (releaseQueue.length > 0) {
    releaseQueue.shift()!()
    await new Promise((resolve) => setImmediate(resolve))
  }

  const outcomes = await settledPromise
  assert.equal(peak, 2, 'concurrency must never exceed the semaphore cap of 2')
  assert.equal(inFlight, 0)
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 4)
  assert.equal(outcomes.filter((item) => item.status === 'rejected').length, 1)

  // Semaphore remains usable after a rejection.
  const followUp = await semaphore.run(async () => 'recovered')
  assert.equal(followUp, 'recovered')
})
