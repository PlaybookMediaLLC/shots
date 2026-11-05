import 'server-only'
import { isIP } from 'node:net'
import { z } from 'zod'
import type { ScreenshotRequest } from '@/lib/api/schemas'
import { isBlankImage } from '@/lib/screenshot-blank'

const MICROLINK_API_URL = process.env.SCREENSHOT_API_URL || 'https://api.microlink.io'
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024
const MAX_SCREENSHOT_REDIRECTS = 3
const E2E_ALLOWED_DOWNLOAD_HOSTS = new Set(
  process.env.NODE_ENV === 'production'
    ? []
    : (process.env.SCREENSHOT_E2E_ALLOWED_DOWNLOAD_HOSTS ?? '')
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean)
)

const microlinkResponseSchema = z.object({
  data: z
    .object({
      message: z.string().optional(),
      screenshot: z.object({ url: z.string().url() }).optional(),
      url: z.string().optional(),
    })
    .optional(),
  status: z.string(),
})

type Viewport = {
  height: string
  isMobile: string
  width: string
}

export type ScreenshotCapture = {
  screenshot: string
  strategy: 'microlink'
}

export type ScreenshotFailure = {
  message: string
  status: number
}

class UnsafeCaptureUrlError extends Error {
  constructor() {
    super('unsafe_capture_url')
  }
}

class UnsafeScreenshotDownloadError extends Error {
  constructor() {
    super('unsafe_screenshot_download')
  }
}

// Explicit ranges preserve the SSRF boundary; do not split this check by caller.
// eslint-disable-next-line complexity
function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number)
  const [first, second] = octets
  return (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255) ||
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first === 224 ||
    first === 255 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19))
  )
}

function isPrivateIpv6(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return (
    value === '::' ||
    value === '::1' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    value.startsWith('fe80:') ||
    value.startsWith('::ffff:127.') ||
    value.startsWith('::ffff:10.') ||
    value.startsWith('::ffff:192.168.')
  )
}

function isUnsafeCaptureHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local')
  ) {
    return true
  }

  return isIP(normalized) === 4
    ? isPrivateIpv4(normalized)
    : isIP(normalized) === 6 && isPrivateIpv6(normalized)
}

export function assertPublicCaptureUrl(value: string): void {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || isUnsafeCaptureHost(url.hostname)) {
    throw new UnsafeCaptureUrlError()
  }
}

function assertSafeScreenshotDownloadUrl(url: URL): void {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const allowedE2EHost = E2E_ALLOWED_DOWNLOAD_HOSTS.has(hostname)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    (isUnsafeCaptureHost(hostname) && !allowedE2EHost)
  ) {
    throw new UnsafeScreenshotDownloadError()
  }
}

function getViewport(deviceType: ScreenshotRequest['deviceType']): Viewport {
  if (deviceType === 'mobile') {
    // A current iPhone viewport: phone mockups have tall screens, and a 375x667
    // capture had to be cropped at the sides to fill them.
    return { height: '844', isMobile: 'true', width: '390' }
  }

  return { height: '1080', isMobile: 'false', width: '1920' }
}

function getCaptureUrl(input: ScreenshotRequest, waitForTimeout?: number): string {
  const viewport = getViewport(input.deviceType)
  const params = new URLSearchParams({
    'viewport.height': viewport.height,
    'viewport.isMobile': viewport.isMobile,
    'viewport.width': viewport.width,
    colorScheme: input.colorScheme,
    meta: 'false',
    screenshot: 'true',
    url: input.url,
  })
  if (waitForTimeout) params.set('waitForTimeout', String(waitForTimeout))

  return `${MICROLINK_API_URL}/?${params.toString()}`
}

function getServiceError(response: Response, data: z.infer<typeof microlinkResponseSchema>): Error {
  if (response.status === 408 || response.status === 504) {
    return new Error('timeout')
  }
  if (response.status === 429) {
    return new Error('connection_error')
  }

  return new Error(
    data.data?.url || data.data?.message || `Screenshot API returned ${response.status}`
  )
}

async function requestScreenshotUrl(
  input: ScreenshotRequest,
  waitForTimeout?: number
): Promise<string> {
  const response = await fetch(getCaptureUrl(input, waitForTimeout), {
    method: 'GET',
    signal: AbortSignal.timeout(30_000),
  })
  const data: unknown = await response.json()
  const parsed = microlinkResponseSchema.safeParse(data)

  if (!parsed.success || parsed.data.status !== 'success' || !parsed.data.data?.screenshot?.url) {
    throw getServiceError(response, parsed.success ? parsed.data : { status: 'invalid' })
  }

  return parsed.data.data.screenshot.url
}

function isSupportedImage(buffer: Buffer): boolean {
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8
  return isPng || isJpeg
}

function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400
}

async function readScreenshot(response: Response): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_SCREENSHOT_BYTES) {
    throw new Error('Screenshot exceeds the maximum allowed size')
  }

  if (!response.body) {
    throw new Error('Empty response from screenshot API')
  }

  const chunks: Uint8Array[] = []
  let bytes = 0
  const reader = response.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    bytes += value.byteLength
    if (bytes > MAX_SCREENSHOT_BYTES) {
      await reader.cancel()
      throw new Error('Screenshot exceeds the maximum allowed size')
    }
    chunks.push(value)
  }

  return Buffer.concat(chunks, bytes)
}

async function downloadScreenshot(url: string): Promise<Buffer> {
  let screenshotUrl = new URL(url)
  for (let redirectCount = 0; redirectCount <= MAX_SCREENSHOT_REDIRECTS; redirectCount += 1) {
    assertSafeScreenshotDownloadUrl(screenshotUrl)
    const response = await fetch(screenshotUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(25_000),
    })

    if (isRedirect(response)) {
      const location = response.headers.get('location')
      if (!location) {
        throw new Error('Screenshot API returned a redirect without a destination')
      }
      screenshotUrl = new URL(location, screenshotUrl)
      continue
    }
    if (!response.ok) {
      throw new Error(`Screenshot API returned ${response.status}`)
    }

    const buffer = await readScreenshot(response)
    if (!buffer.length) {
      throw new Error('Empty response from screenshot API')
    }
    if (!isSupportedImage(buffer)) {
      throw new Error('Invalid image format received from screenshot API: expected PNG or JPEG')
    }

    return buffer
  }

  throw new Error('Screenshot API returned too many redirects')
}

function normalizeCaptureError(error: unknown): Error {
  if (error instanceof Error && error.name === 'AbortError') {
    return new Error('timeout')
  }
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return new Error('connection_error')
  }
  if (error instanceof Error) {
    return error
  }

  return new Error('Screenshot service failed')
}

/** How long a blank capture's retry waits after page load, for intro and fade-in animations. */
const SETTLE_WAIT_MS = 4000

async function captureOnce(input: ScreenshotRequest, waitForTimeout?: number): Promise<Buffer> {
  return downloadScreenshot(await requestScreenshotUrl(input, waitForTimeout))
}

/**
 * Captures once and, when the result is a single flat colour, once more after
 * letting the page settle. Pages with an intro animation are still blank when
 * the service shoots right after load. Throws 'blank_capture' if it stays blank.
 */
export async function captureScreenshot(input: ScreenshotRequest): Promise<ScreenshotCapture> {
  try {
    // Checked here, below every caller, not only in the routes that remember to.
    assertPublicCaptureUrl(input.url)
    let image = await captureOnce(input)
    if (await isBlankImage(image)) {
      image = await captureOnce(input, SETTLE_WAIT_MS)
      if (await isBlankImage(image)) throw new Error('blank_capture')
    }
    return { screenshot: image.toString('base64'), strategy: 'microlink' }
  } catch (error) {
    throw normalizeCaptureError(error)
  }
}

function includesAny(message: string, patterns: string[]): boolean {
  return patterns.some((pattern) => message.includes(pattern))
}

export function getScreenshotFailure(error: unknown): ScreenshotFailure {
  const message = error instanceof Error ? error.message : ''

  if (includesAny(message, ['timeout', 'Timeout'])) {
    return {
      message: 'Website took too long to load. Please try again or try a different URL.',
      status: 408,
    }
  }
  if (message === 'blank_capture') {
    return {
      message:
        'The page was still blank after waiting for it to load. It may need a login or block screenshots.',
      status: 502,
    }
  }
  if (message === 'unsafe_capture_url') {
    return { message: 'This address cannot be captured.', status: 400 }
  }
  if (includesAny(message, ['connection_error', 'ECONNREFUSED'])) {
    return { message: 'Screenshot service is unavailable. Please try again later.', status: 503 }
  }
  if (includesAny(message, ['ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION'])) {
    return {
      message: 'Could not connect to the website. Please check the URL and try again.',
      status: 400,
    }
  }
  if (includesAny(message, ['SSL', 'certificate', 'ERR_CERT'])) {
    return {
      message: 'Website has SSL certificate issues. The screenshot may be incomplete.',
      status: 400,
    }
  }

  return {
    message:
      'Failed to capture screenshot. Please try again or contact support if the issue persists.',
    status: 500,
  }
}
