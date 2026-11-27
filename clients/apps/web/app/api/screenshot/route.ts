import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { apiError, methodNotAllowed, type ApiErrorCode } from '@/lib/api/errors'
import { getClientIdentifier } from '@/lib/api/client-identity'
import { isInvalidRequest, parseJson } from '@/lib/api/request'
import { screenshotRequestSchema, type ScreenshotRequest } from '@/lib/api/schemas'
import { SCREENSHOT_RATE_LIMIT } from '@/lib/api/rate-limit-policy'
import { checkRateLimit, type RateLimitResult } from '@/lib/rate-limit'
import {
  cacheScreenshot,
  getCachedScreenshotBytes,
  invalidateCache,
  normalizeUrl,
} from '@/lib/screenshot-cache'
import {
  assertPublicCaptureUrl,
  captureScreenshot,
  getScreenshotFailure,
} from '@/lib/screenshot-service'
import { requirePaidAccess } from '@/lib/api/require-account'

export const maxDuration = 60

function getRateLimitHeaders(rateLimit: RateLimitResult): Record<string, string> {
  const retryAfter = Math.max(1, Math.ceil((rateLimit.resetAt - Date.now()) / 1000))
  return {
    'Retry-After': retryAfter.toString(),
    'X-RateLimit-Limit': rateLimit.limit.toString(),
    'X-RateLimit-Remaining': '0',
    'X-RateLimit-Reset': rateLimit.resetAt.toString(),
  }
}

async function getRateLimitResponse(request: NextRequest): Promise<NextResponse | null> {
  try {
    const rateLimit = await checkRateLimit(
      getClientIdentifier(request.headers),
      SCREENSHOT_RATE_LIMIT
    )
    if (rateLimit.allowed) {
      return null
    }

    const retryAfter = Math.max(1, Math.ceil((rateLimit.resetAt - Date.now()) / 1000))
    return apiError(
      429,
      'rate_limited',
      'Rate limit exceeded. Please try again later.',
      `Wait ${retryAfter} seconds, then retry.`,
      { retryAfter },
      getRateLimitHeaders(rateLimit)
    )
  } catch (error) {
    console.error('Rate limit check failed:', error)
    return apiError(
      503,
      'upstream_unavailable',
      'Rate limiting is unavailable. Please try again shortly.',
      'Retry later. Requests fail closed while rate limiting is unavailable.'
    )
  }
}

function getCacheKey(url: string, input: ScreenshotRequest): string {
  return `${url}:${input.deviceType}:${input.colorScheme}`
}

async function refreshCache(input: ScreenshotRequest, url: string): Promise<void> {
  if (!input.forceRefresh) {
    return
  }

  try {
    await invalidateCache(url)
  } catch (error) {
    console.warn('Failed to invalidate cache:', error)
  }
}

async function loadCachedScreenshot(input: ScreenshotRequest, url: string): Promise<Buffer | null> {
  if (input.forceRefresh) {
    return null
  }

  try {
    // Blank captures are already rejected before caching inside captureScreenshot.
    return await getCachedScreenshotBytes(getCacheKey(url, input))
  } catch (error) {
    console.warn('Cache check failed:', error)
    return null
  }
}

async function storeScreenshot(
  input: ScreenshotRequest,
  url: string,
  screenshot: string
): Promise<void> {
  try {
    await cacheScreenshot(getCacheKey(url, input), screenshot)
  } catch (error) {
    console.warn('Failed to cache screenshot:', error)
  }
}

type ScreenshotResponseInput = {
  bytes?: Buffer
  cached: boolean
  input: ScreenshotRequest
  screenshot?: string
  strategy?: 'microlink'
  url: string
}

function wantsRawPng(request: NextRequest): boolean {
  const accept = request.headers.get('accept') ?? ''
  return accept.includes('image/png') && !accept.includes('application/json')
}

function sniffImageMediaType(bytes: Buffer): 'image/jpeg' | 'image/png' {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : 'image/png'
}

function screenshotResponse(request: NextRequest, response: ScreenshotResponseInput): NextResponse {
  if (wantsRawPng(request)) {
    const image = response.bytes ?? Buffer.from(response.screenshot ?? '', 'base64')
    const view =
      image.buffer instanceof ArrayBuffer
        ? new Uint8Array(image.buffer, image.byteOffset, image.byteLength)
        : new Uint8Array(image)
    return new NextResponse(view, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Type': sniffImageMediaType(image),
        'X-Screenshot-Cache': response.cached ? 'HIT' : 'MISS',
      },
      status: 200,
    })
  }
  return NextResponse.json({
    cached: response.cached,
    colorScheme: response.input.colorScheme,
    deviceType: response.input.deviceType,
    screenshot: response.screenshot ?? response.bytes?.toString('base64') ?? '',
    strategy: response.strategy,
    url: response.url,
  })
}

function invalidRequestResponse(error: unknown): NextResponse {
  if (error instanceof ZodError) {
    const issue = error.issues[0]
    if (issue?.path[0] === 'url') {
      const missing = issue.code === 'invalid_type'
      return apiError(
        400,
        missing ? 'invalid_request' : 'invalid_url',
        missing ? 'URL is required' : 'Invalid URL format',
        'Send an absolute public http or https URL, for example {"url": "https://example.com"}.'
      )
    }
    if (issue?.path[0] === 'deviceType' || issue?.path[0] === 'colorScheme') {
      return apiError(
        400,
        'unsupported_value',
        'Invalid screenshot option',
        'Set deviceType to desktop or mobile and colorScheme to light or dark.'
      )
    }
  }

  return apiError(
    400,
    'invalid_request',
    'Invalid screenshot request',
    'Send valid JSON with an absolute public http or https "url".'
  )
}

const failureResponses: Record<number, { code: ApiErrorCode; hint: string }> = {
  400: { code: 'invalid_url', hint: 'Use an absolute, publicly reachable http or https URL.' },
  408: { code: 'upstream_timeout', hint: 'Retry the request, or capture a lighter page.' },
  502: {
    code: 'upstream_failed',
    hint: 'Check that the page shows content to a logged-out visitor, then retry.',
  },
  503: {
    code: 'upstream_unavailable',
    hint: 'This is a transient upstream failure. Retry with exponential backoff.',
  },
}

function screenshotFailureResponse(error: unknown): NextResponse {
  const failure = getScreenshotFailure(error)
  const known = failureResponses[failure.status]
  if (known) {
    return apiError(failure.status, known.code, failure.message, known.hint)
  }

  return apiError(
    500,
    'internal_error',
    failure.message,
    'Retry the request. If it keeps failing, contact support.'
  )
}

// Keep the account check and fail-closed rate limiting ahead of request parsing, SSRF validation,
// cache access, and capture so no unthrottled work can cross the public boundary.
export async function POST(request: NextRequest): Promise<NextResponse> {
  const denied = await requirePaidAccess(request)
  if (denied) return denied

  const rateLimitResponse = await getRateLimitResponse(request)
  if (rateLimitResponse) {
    return rateLimitResponse
  }

  try {
    const input = await parseJson(request, screenshotRequestSchema)
    assertPublicCaptureUrl(input.url)
    const url = normalizeUrl(input.url)
    await refreshCache(input, url)
    const cachedBytes = await loadCachedScreenshot(input, url)
    if (cachedBytes?.length) {
      return screenshotResponse(request, { bytes: cachedBytes, cached: true, input, url })
    }

    const capture = await captureScreenshot({ ...input, url })
    await storeScreenshot(input, url, capture.screenshot)
    return screenshotResponse(request, {
      cached: false,
      input,
      screenshot: capture.screenshot,
      strategy: capture.strategy,
      url,
    })
  } catch (error) {
    console.error('Screenshot error:', error)
    if (isInvalidRequest(error)) {
      return invalidRequestResponse(error)
    }

    return screenshotFailureResponse(error)
  }
}

export async function GET(): Promise<NextResponse> {
  return methodNotAllowed(['POST'])
}
