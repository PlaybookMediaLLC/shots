import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { testHooksAllowed } from '@/lib/e2e-hooks'

/**
 * Fetch a release source link without letting the link reach anything private.
 *
 * Every hop is checked before it is requested: http(s) only, no credentials in
 * the URL, default web ports, and every address the hostname resolves to must
 * be public. The connection then uses the address that was checked (the DNS
 * lookup is pinned), so a name cannot resolve to a public address for the
 * check and a private one for the request. Redirects are followed by hand and
 * checked again. Responses are capped in size and time and must be text.
 */

const DEFAULT_MAX_BYTES = 1_500_000
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_REDIRECTS = 4
const WEB_PORTS = new Set(['', '80', '443', '8080', '8443'])
const TEXT_TYPES = [
  'text/html',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'application/json',
  'application/json+oembed',
  'application/xml',
  'text/xml',
  'application/xhtml+xml',
  'application/vnd.github+json',
]

function ipv4Parts(address: string): number[] {
  return address.split('.').map((part) => Number(part))
}

/** Whether an IP address is publicly routable (not loopback, private, link-local, CGNAT, multicast, reserved). */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) {
    const [a = 0, b = 0, c = 0] = ipv4Parts(address)
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false
    if (a === 100 && b >= 64 && b <= 127) return false // carrier-grade NAT
    if (a === 169 && b === 254) return false // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
    if (a === 198 && (b === 18 || b === 19)) return false // benchmarking
    if (a === 198 && b === 51 && c === 100) return false
    if (a === 203 && b === 0 && c === 113) return false
    return true
  }
  if (kind === 6) {
    if (address.includes('%')) return false
    // Canonicalize expanded and IPv4-mapped forms before checking ranges.
    const value = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase()
    const mapped = value.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/)
    if (mapped) {
      const upper = Number.parseInt(mapped[1], 16)
      const lower = Number.parseInt(mapped[2], 16)
      return isPublicAddress(`${upper >> 8}.${upper & 255}.${lower >> 8}.${lower & 255}`)
    }
    // Only global unicast, excluding transition tunnels and documentation.
    if (!/^[23][0-9a-f]{3}:/.test(value)) return false
    if (
      value.startsWith('2002:') ||
      value.startsWith('2001::') ||
      value.startsWith('2001:0:') ||
      value.startsWith('2001:db8:') ||
      value.startsWith('2001:2:') ||
      /^2001:[12][0-9a-f]:/.test(value) ||
      value.startsWith('3fff:')
    )
      return false
    return true
  }
  return false
}

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>

export type TransportResponse = {
  body: AsyncIterable<Buffer | string>
  destroy: () => void
  headers: Record<string, string | string[] | undefined>
  status: number
}

export type Transport = (request: {
  address: string
  family: number
  headers: Record<string, string>
  timeoutMs: number
  url: URL
}) => Promise<TransportResponse>

export type SafeFetchOptions = {
  /** When supplied, every redirect hop must remain on one of these exact origins. */
  allowedOrigins?: ReadonlySet<string>
  /** Read text error pages for diagnostics; redirects and SSRF checks still apply. */
  acceptErrorStatus?: boolean
  /** Extra request headers (for example an Accept header for an API). */
  headers?: Record<string, string>
  /**
   * Hosts allowed even though they resolve privately. Only for test
   * infrastructure (the e2e mock), read from SCREENSHOT_E2E_ALLOWED_DOWNLOAD_HOSTS.
   */
  allowedPrivateHosts?: ReadonlySet<string>
  maxBytes?: number
  resolve?: Resolver
  timeoutMs?: number
  transport?: Transport
}

export type FetchedText =
  | {
      body: string
      contentType: string
      headers?: TransportResponse['headers']
      /** Every response on the way, redirects first and the page last. */
      hops?: Array<{ status: number; url: string }>
      ok: true
      truncated: boolean
      url: string
    }
  | { ok: false; reason: string; status: 'blocked' | 'failed' }

const defaultResolver: Resolver = async (hostname) =>
  lookup(hostname, { all: true, verbatim: true })

const nodeTransport: Transport = ({ address, family, headers, timeoutMs, url }) =>
  new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http
    const deadline = AbortSignal.timeout(timeoutMs)
    // The deadline otherwise surfaces as "The operation was aborted" or "aborted".
    const timedOut = () => new Error('The source took too long to respond.')
    const request = client.request(
      url,
      {
        headers,
        // Connect to the address that was checked, whatever DNS says now.
        lookup: (_hostname, options, callback) => {
          const done = callback as (
            error: Error | null,
            address: string | Array<{ address: string; family: number }>,
            family?: number
          ) => void
          if ((options as { all?: boolean }).all) done(null, [{ address, family }])
          else done(null, address, family)
        },
        method: 'GET',
        // A socket timeout only measures idle time. A trickling response must
        // still stop at the deadline, including while its body is being read.
        signal: deadline,
        timeout: timeoutMs,
      },
      (response) => {
        deadline.addEventListener('abort', () => response.destroy(timedOut()), { once: true })
        resolve({
          body: response,
          destroy: () => response.destroy(),
          headers: response.headers,
          status: response.statusCode ?? 0,
        })
      }
    )
    request.on('timeout', () => request.destroy(timedOut()))
    request.on('error', (error) => reject(deadline.aborted ? timedOut() : error))
    request.end()
  })

function header(headers: TransportResponse['headers'], name: string): string {
  const value = headers[name]
  return (Array.isArray(value) ? value[0] : value) ?? ''
}

export function allowedTestHosts(): Set<string> {
  // The same gate the screenshot downloader uses: a deployed build never
  // reaches a private address, however its environment is set (lib/e2e-hooks.ts).
  if (!testHooksAllowed()) return new Set()
  return new Set(
    (process.env.SCREENSHOT_E2E_ALLOWED_DOWNLOAD_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  )
}

async function checkHop(
  url: URL,
  options: SafeFetchOptions
): Promise<{ address: string; family: number } | { reason: string }> {
  if (!['http:', 'https:'].includes(url.protocol))
    return { reason: 'Only http and https links are read.' }
  if (url.username || url.password) return { reason: 'Links with credentials are not read.' }
  if (options.allowedOrigins && !options.allowedOrigins.has(url.origin)) {
    return { reason: 'The link points at an origin that is not allowed.' }
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const testHost = options.allowedPrivateHosts?.has(hostname) ?? false
  if (!testHost && !WEB_PORTS.has(url.port)) return { reason: 'Only standard web ports are read.' }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    if (!testHost) return { reason: 'Local addresses are not read.' }
  }
  let addresses: Array<{ address: string; family: number }>
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) }]
  } else {
    try {
      addresses = await (options.resolve ?? defaultResolver)(hostname)
    } catch {
      return { reason: 'The host could not be resolved.' }
    }
  }
  if (addresses.length === 0) return { reason: 'The host could not be resolved.' }
  if (!testHost && addresses.some((entry) => !isPublicAddress(entry.address))) {
    return { reason: 'The link points at a private network address.' }
  }
  return addresses[0]!
}

type FetchFailure = Extract<FetchedText, { ok: false }>

async function withinDeadline<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('The source took too long to respond.')),
          timeoutMs
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** One response in a redirect chain. */
export type Hop = { status: number; url: string }

/** Follow checked redirects to the first non-redirect response; failures are already closed. */
async function safeRequest(
  input: string,
  options: SafeFetchOptions,
  /** Return 4xx and 5xx responses instead of failing on them. */
  acceptErrors = false
): Promise<{ hops: Hop[]; ok: true; response: TransportResponse; url: URL } | FetchFailure> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const transport = options.transport ?? nodeTransport
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { ok: false, reason: 'The link is not a valid URL.', status: 'blocked' }
  }
  const hops: Hop[] = []
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let checked: Awaited<ReturnType<typeof checkHop>>
    try {
      checked = await withinDeadline(checkHop(url, options), Math.max(1, deadline - Date.now()))
    } catch {
      return { ok: false, reason: 'The source took too long to resolve.', status: 'failed' }
    }
    if ('reason' in checked) return { ok: false, reason: checked.reason, status: 'blocked' }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      return { ok: false, reason: 'The source took too long to respond.', status: 'failed' }
    }
    let response: TransportResponse
    try {
      response = await transport({
        address: checked.address,
        family: checked.family,
        headers: {
          accept: 'text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.1',
          'user-agent': 'ScreenshotStudioLaunchBot/1.0 (+release spec drafting)',
          ...options.headers,
        },
        timeoutMs: remainingMs,
        url,
      })
    } catch (error) {
      return {
        ok: false,
        reason:
          error instanceof Error ? error.message.slice(0, 200) : 'The source could not be read.',
        status: 'failed',
      }
    }
    hops.push({ status: response.status, url: url.toString() })
    if (response.status >= 300 && response.status < 400) {
      const location = header(response.headers, 'location')
      response.destroy()
      if (!location)
        return { ok: false, reason: 'A redirect had no destination.', status: 'failed' }
      try {
        url = new URL(location, url)
      } catch {
        return { ok: false, reason: 'A redirect pointed at an invalid URL.', status: 'blocked' }
      }
      continue
    }
    if (response.status === 0 || (response.status >= 400 && !acceptErrors)) {
      response.destroy()
      return { ok: false, reason: `The source returned HTTP ${response.status}.`, status: 'failed' }
    }
    return { hops, ok: true, response, url }
  }
  return { ok: false, reason: 'The link redirected too many times.', status: 'failed' }
}

async function readBody(
  response: TransportResponse,
  maxBytes: number
): Promise<{ bytes: Buffer; ok: true; truncated: boolean } | FetchFailure> {
  const chunks: Buffer[] = []
  let size = 0
  let truncated = false
  try {
    for await (const chunk of response.body) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      if (size + buffer.length > maxBytes) {
        chunks.push(buffer.subarray(0, maxBytes - size))
        truncated = true
        response.destroy()
        break
      }
      chunks.push(buffer)
      size += buffer.length
    }
  } catch (error) {
    if (!truncated) {
      return {
        ok: false,
        reason:
          error instanceof Error ? error.message.slice(0, 200) : 'The source could not be read.',
        status: 'failed',
      }
    }
  }
  return { bytes: Buffer.concat(chunks), ok: true, truncated }
}

function contentTypeOf(response: TransportResponse): string {
  return header(response.headers, 'content-type').split(';')[0]!.trim().toLowerCase()
}

export async function safeFetchText(
  input: string,
  options: SafeFetchOptions = {}
): Promise<FetchedText> {
  const requested = await safeRequest(input, options, options.acceptErrorStatus)
  if (!requested.ok) return requested
  const { hops, response, url } = requested
  const contentType = contentTypeOf(response)
  if (contentType && !TEXT_TYPES.includes(contentType)) {
    response.destroy()
    return { ok: false, reason: `The source is ${contentType}, not text.`, status: 'failed' }
  }
  const read = await readBody(response, options.maxBytes ?? DEFAULT_MAX_BYTES)
  if (!read.ok) return read
  return {
    body: read.bytes.toString('utf8'),
    contentType: contentType || 'text/html',
    headers: response.headers,
    hops,
    ok: true,
    truncated: read.truncated,
    url: url.toString(),
  }
}

/** A response body of any type, read under the same checks and cap as `safeFetchText`. */
export type FetchedBytes =
  { bytes: Buffer; contentType: string; ok: true; truncated: boolean; url: string } | FetchFailure

/** Fetch a body of any content type, such as an image, under the same checks. */
export async function safeFetchBytes(
  input: string,
  options: SafeFetchOptions = {}
): Promise<FetchedBytes> {
  const requested = await safeRequest(input, options)
  if (!requested.ok) return requested
  const read = await readBody(requested.response, options.maxBytes ?? DEFAULT_MAX_BYTES)
  if (!read.ok) return read
  return {
    bytes: read.bytes,
    contentType: contentTypeOf(requested.response),
    ok: true,
    truncated: read.truncated,
    url: requested.url.toString(),
  }
}

/** Whether a link answers 2xx, under the same checks as `safeFetchText`. The body is never read. */
export async function safeProbe(input: string, options: SafeFetchOptions = {}): Promise<boolean> {
  const requested = await safeRequest(input, options)
  if (requested.ok) requested.response.destroy()
  return requested.ok
}

/** Where a link ends up, with its status, whatever the status is. The body is never read. */
export async function safeResolve(
  input: string,
  options: SafeFetchOptions = {}
): Promise<{ hops: Hop[]; ok: true; status: number; url: string } | FetchFailure> {
  const requested = await safeRequest(input, options, true)
  if (!requested.ok) return requested
  requested.response.destroy()
  return {
    hops: requested.hops,
    ok: true,
    status: requested.response.status,
    url: requested.url.toString(),
  }
}

/**
 * A page as a crawler receives it, error statuses included: status, headers,
 * and the start of the body, so a block or bot challenge can be recognized.
 */
export async function safeFetchPage(
  input: string,
  options: SafeFetchOptions = {}
): Promise<
  | {
      body: string
      headers: TransportResponse['headers']
      hops: Hop[]
      ok: true
      status: number
      url: string
    }
  | FetchFailure
> {
  const requested = await safeRequest(input, options, true)
  if (!requested.ok) return requested
  const read = await readBody(requested.response, options.maxBytes ?? DEFAULT_MAX_BYTES)
  if (!read.ok) return read
  return {
    body: read.bytes.toString('utf8'),
    headers: requested.response.headers,
    hops: requested.hops,
    ok: true,
    status: requested.response.status,
    url: requested.url.toString(),
  }
}
