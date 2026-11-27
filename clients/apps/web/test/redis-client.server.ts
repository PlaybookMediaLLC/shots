import assert from 'node:assert/strict'
import test from 'node:test'
import type { RedisClientType } from 'redis'
import { getRedisClient, redisReconnectStrategy, setRedisClientFactoryForTest } from '@/lib/redis'

test('redisReconnectStrategy backs off exponentially up to 2s with jitter and stops after 10 retries', () => {
  assert.equal(
    redisReconnectStrategy(0, () => 0),
    50
  )
  assert.equal(
    redisReconnectStrategy(1, () => 0),
    100
  )
  assert.equal(
    redisReconnectStrategy(2, () => 0.5),
    225
  )
  assert.equal(
    redisReconnectStrategy(6, () => 0),
    2_000
  )
  assert.equal(
    redisReconnectStrategy(9, () => 0.99),
    2_049
  )
  const exhausted = redisReconnectStrategy(10, () => 0)
  assert.ok(exhausted instanceof Error)
  assert.match(exhausted.message, /exhausted/)
})

test('getRedisClient shares in-flight connect, preserves real error on closed failure, and avoids leaking duplicate clients while reconnecting', async (t) => {
  const previousUrl = process.env.REDIS_URL
  process.env.REDIS_URL = 'redis://127.0.0.1:6399'
  t.after(() => {
    setRedisClientFactoryForTest()
    if (previousUrl === undefined) delete process.env.REDIS_URL
    else process.env.REDIS_URL = previousUrl
  })

  // 1. Failed connect when node-redis already marked isOpen=false must preserve the original error
  //    (not throw ClientClosedError from destroy()) and clear connecting for future retries.
  let created = 0
  let destroyCalls = 0
  setRedisClientFactoryForTest(() => {
    created += 1
    const fake = {
      connect: async () => {
        fake.isOpen = false
        throw new Error('ECONNREFUSED')
      },
      destroy: () => {
        destroyCalls += 1
        throw new Error('ClientClosedError')
      },
      isOpen: false,
      isReady: false,
    }
    return fake as unknown as RedisClientType
  })
  await assert.rejects(getRedisClient(), /ECONNREFUSED/)
  assert.equal(destroyCalls, 0)
  assert.equal(created, 1)

  // 2. Concurrent callers share one connect() promise; a transiently reconnecting client
  //    (isOpen=true, isReady=false) is reused rather than leaking a second client;
  //    once closed (isOpen=false), the next call replaces it cleanly.
  let releaseConnect: (() => void) | undefined
  created = 0
  const instances: Array<{ isOpen: boolean; isReady: boolean }> = []
  setRedisClientFactoryForTest(() => {
    created += 1
    const fake = {
      connect: async () => {
        if (created === 1) {
          await new Promise<void>((resolve) => {
            releaseConnect = resolve
          })
        }
        fake.isOpen = true
        fake.isReady = true
        return fake
      },
      destroy: () => {
        fake.isOpen = false
        fake.isReady = false
      },
      isOpen: false,
      isReady: false,
    }
    instances.push(fake)
    return fake as unknown as RedisClientType
  })

  const first = getRedisClient()
  const second = getRedisClient()
  releaseConnect?.()
  const [c1, c2] = await Promise.all([first, second])
  assert.equal(c1, c2)
  assert.equal(created, 1)

  // Simulate transient disconnect (isOpen remains true while node-redis reconnects).
  instances[0]!.isReady = false
  const duringReconnect = await getRedisClient()
  assert.equal(duringReconnect, c1)
  assert.equal(created, 1)

  // Simulate reconnect exhaustion / closed client (isOpen becomes false).
  instances[0]!.isOpen = false
  const replacement = await getRedisClient()
  assert.notEqual(replacement, c1)
  assert.equal(created, 2)
})
