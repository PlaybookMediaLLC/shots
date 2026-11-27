import createClient from 'openapi-fetch'
import type { paths } from './schema.js'

export type { components, operations, paths } from './schema.js'

const DEFAULT_SHOTS_CLIENT_TIMEOUT_MS = 30_000

/** Where the client sends requests and the workspace API key it sends. */
export type ShotsClientOptions = {
  /** A workspace API key (`ss_...`), sent as `X-API-Key`. */
  apiKey: string
  /** Defaults to production. */
  baseUrl?: string
  /** Per-request timeout in milliseconds (defaults to 30_000). */
  timeoutMs?: number
  /** Optional default AbortSignal applied to all requests from this client. */
  signal?: AbortSignal
  /** Optional custom fetch implementation. */
  fetch?: typeof fetch
}

/**
 * A client for the Shots REST API. Every path, parameter, body, and response
 * is typed from the production OpenAPI document (`/openapi.json`).
 *
 * ```ts
 * const shots = createShotsClient({ apiKey: process.env.SHOTS_API_KEY! })
 * const { data, error } = await shots.GET('/api/v1/campaigns')
 * ```
 */
export function createShotsClient({
  apiKey,
  baseUrl = 'https://shots.playbookmedia.io',
  timeoutMs = DEFAULT_SHOTS_CLIENT_TIMEOUT_MS,
  signal: defaultSignal,
  fetch: baseFetch = fetch,
}: ShotsClientOptions) {
  const boundedFetch: typeof fetch = (input, init) => {
    const signals: AbortSignal[] = []
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
    if (defaultSignal) signals.push(defaultSignal)
    const requestSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined)
    if (requestSignal) signals.push(requestSignal)
    const signal =
      signals.length === 0
        ? undefined
        : signals.length === 1
          ? signals[0]
          : AbortSignal.any(signals)
    return baseFetch(input, { ...init, signal })
  }
  return createClient<paths>({
    baseUrl,
    fetch: boundedFetch,
    headers: { 'X-API-Key': apiKey },
  })
}
