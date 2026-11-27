import { createHash } from 'crypto'
import type { BackendScreenshotCacheFilter } from 'screenshot-studio-backend-sdk'
import { orNull, serviceBackend } from './backend/sdk'

const CACHE_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000
const CACHE_VARIANTS = ['desktop:light', 'desktop:dark', 'mobile:light', 'mobile:dark']

function getCacheVariants(url: string): string[] {
  const normalizedUrl = normalizeUrl(url)
  return CACHE_VARIANTS.map((variant) => normalizeUrl(`${normalizedUrl}:${variant}`))
}

async function deleteCacheRecord(hash: string): Promise<void> {
  await serviceBackend()
    .deleteScreenshotCache(hash)
    .catch(() => undefined)
}

async function purgeCache(filter: BackendScreenshotCacheFilter): Promise<void> {
  await serviceBackend().purgeScreenshotCache(filter)
}

export function normalizeUrl(urlString: string): string {
  try {
    const url = new URL(urlString)
    url.protocol = url.protocol.toLowerCase()
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '')

    if (url.port === '80' && url.protocol === 'http:') {
      url.port = ''
    }
    if (url.port === '443' && url.protocol === 'https:') {
      url.port = ''
    }
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1)
    }

    url.hash = ''
    const sorted = [...url.searchParams.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    )
    url.search = sorted.length ? `?${new URLSearchParams(sorted)}` : ''
    return url.toString()
  } catch {
    return urlString
  }
}

export function hashUrl(url: string): string {
  return createHash('sha256').update(normalizeUrl(url)).digest('hex')
}

export async function getCachedScreenshotBytes(
  url: string,
  maxAgeMs: number = CACHE_MAX_AGE_MS
): Promise<Buffer | null> {
  try {
    const hash = hashUrl(url)
    const cached = await orNull(serviceBackend().getScreenshotCache(hash))
    if (!cached) {
      return null
    }
    if (Date.now() - new Date(cached.createdAt).getTime() > maxAgeMs) {
      // `url` is already a variant cache key, so drop this entry directly.
      await deleteCacheRecord(hash)
      return null
    }

    const bytes = await orNull(serviceBackend().getScreenshotCacheImage(hash))
    return bytes ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null
  } catch (error) {
    console.error('Error reading cached screenshot:', error)
    return null
  }
}

export async function getCachedScreenshot(
  url: string,
  maxAgeMs: number = CACHE_MAX_AGE_MS
): Promise<string | null> {
  const bytes = await getCachedScreenshotBytes(url, maxAgeMs)
  return bytes ? bytes.toString('base64') : null
}

export async function cacheScreenshot(url: string, screenshotBase64: string): Promise<void> {
  const hash = hashUrl(url)
  await serviceBackend().putScreenshotCacheObject(hash, Buffer.from(screenshotBase64, 'base64'))
  const normalizedUrl = normalizeUrl(url)
  const objectKey = `screenshots/${hash}.png`

  await serviceBackend().putScreenshotCache(hash, {
    cloudinaryPublicId: objectKey,
    cloudinaryUrl: objectKey,
    url: normalizedUrl,
  })
}

export async function invalidateCache(url: string): Promise<void> {
  await purgeCache({ urls: getCacheVariants(url) })
}

export async function invalidateCacheBatch(urls: string[]): Promise<void> {
  await Promise.all(urls.map((url) => invalidateCache(url)))
}

export async function clearOldCache(maxAgeMs: number = CACHE_MAX_AGE_MS): Promise<void> {
  await purgeCache({ createdBefore: new Date(Date.now() - maxAgeMs).toISOString() })
}
