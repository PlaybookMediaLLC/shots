import 'server-only'
import { createClient, type RedisClientType } from 'redis'

const REDIS_CONNECT_TIMEOUT_MS = 1_000
const REDIS_MAX_RECONNECT_ATTEMPTS = 10
const REDIS_RECONNECT_BASE_MS = 50
const REDIS_RECONNECT_MAX_MS = 2_000
const REDIS_RECONNECT_JITTER_MS = 50

let redisClient: RedisClientType | undefined
let connecting: Promise<RedisClientType> | undefined

/** Bounded exponential backoff with jitter for post-connect transient disconnects. */
export function redisReconnectStrategy(
  retries: number,
  random: () => number = Math.random
): number | Error {
  if (retries >= REDIS_MAX_RECONNECT_ATTEMPTS) {
    return new Error('Redis reconnect attempts exhausted.')
  }
  const exponential = Math.min(REDIS_RECONNECT_BASE_MS * 2 ** retries, REDIS_RECONNECT_MAX_MS)
  const jitter = Math.floor(Math.max(0, Math.min(1, random())) * REDIS_RECONNECT_JITTER_MS)
  return exponential + jitter
}

type RedisClientFactory = (url: string) => RedisClientType

function defaultCreateRedisClient(url: string): RedisClientType {
  let connectedOnce = false
  const client = createClient({
    // Fail commands immediately while disconnected rather than queuing HTTP requests indefinitely.
    disableOfflineQueue: true,
    socket: {
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      // Fail fast on initial connect so outages return 503 within connectTimeout;
      // once established, recover transient blips in-place with bounded exponential backoff.
      reconnectStrategy: (retries) =>
        connectedOnce
          ? redisReconnectStrategy(retries)
          : new Error('Redis initial connection failed.'),
    },
    url,
  })

  client.on('ready', () => {
    connectedOnce = true
  })
  client.on('error', () => undefined)
  client.on('end', () => {
    if (redisClient === client) {
      redisClient = undefined
    }
  })
  return client
}

let clientFactory: RedisClientFactory = defaultCreateRedisClient

/** Test-only hook to inject a fake client factory and reset cached client state. */
export function setRedisClientFactoryForTest(factory?: RedisClientFactory): void {
  if (redisClient?.isOpen) {
    try {
      redisClient.destroy()
    } catch {
      // Ignore already-closed client during test teardown.
    }
  }
  redisClient = undefined
  connecting = undefined
  clientFactory = factory ?? defaultCreateRedisClient
}

export async function getRedisClient(): Promise<RedisClientType> {
  // Reuse any open client (both ready and actively reconnecting) so transient disconnects
  // never spawn duplicate TCP connections; disableOfflineQueue ensures fast failure until ready.
  if (redisClient?.isOpen) {
    return redisClient
  }
  if (redisClient) {
    redisClient = undefined
  }

  if (!connecting) {
    const url = process.env.REDIS_URL
    if (!url) {
      throw new Error('REDIS_URL is required for rate limiting.')
    }
    const candidate = clientFactory(url)
    connecting = candidate
      .connect()
      .then((client) => {
        redisClient = client
        return client
      })
      .catch((error: unknown) => {
        if (candidate.isOpen) {
          try {
            candidate.destroy()
          } catch {
            // Preserve the original connection error if already closed.
          }
        }
        throw error
      })
      .finally(() => {
        connecting = undefined
      })
  }

  return connecting
}
