import 'server-only'

import sharp from 'sharp'
import { SCREENSHOT_RATE_LIMIT } from '@/lib/api/rate-limit-policy'
import type { OrganizationAccess, TenantContext } from '@/lib/auth/access'
import type { SessionPrincipal } from '@/lib/auth/principal'
import { backendSDK, orNull } from '@/lib/backend/sdk'
import { checkRateLimit } from '@/lib/rate-limit'
import { captureScreenshot, getScreenshotFailure } from '@/lib/screenshot-service'
import { activeRecipeForSurface } from '@/lib/workflows/capture'
import {
  BackendSDKError,
  type CaptureJob,
  type ProductSurface,
  type SurfaceCapture,
  type SurfaceCaptureSource,
} from 'screenshot-studio-backend-sdk'
import { storeGeneratedAsset } from './assets'
import type { ProductSurfaceCreateInput, ProductSurfaceUpdateInput } from './schemas'

type ProductSurfaceAccess = {
  organizationId: string
  principal: SessionPrincipal
  requestId: string
}

function fromBackend(surface: ProductSurface) {
  return {
    ...surface,
    createdAt: new Date(surface.createdAt),
    updatedAt: new Date(surface.updatedAt),
  }
}

export async function listProductSurfaces(context: ProductSurfaceAccess) {
  const result = await backendSDK(context).listProductSurfaces()
  return result.productSurfaces.map(fromBackend)
}

export async function createProductSurface(
  context: OrganizationAccess,
  input: ProductSurfaceCreateInput
) {
  return fromBackend(await backendSDK(context).createProductSurface(input))
}

export async function updateProductSurface(
  context: OrganizationAccess,
  surfaceId: string,
  input: ProductSurfaceUpdateInput
) {
  try {
    return fromBackend(await backendSDK(context).updateProductSurface(surfaceId, input))
  } catch (error) {
    if (error instanceof BackendSDKError && error.status === 404) return null
    throw error
  }
}

export async function deleteProductSurface(context: OrganizationAccess, surfaceId: string) {
  try {
    await backendSDK(context).deleteProductSurface(surfaceId)
    return { id: surfaceId }
  } catch (error) {
    if (error instanceof BackendSDKError && error.status === 404) return null
    throw error
  }
}

/** A surface's 50 newest captures, current first; null when the surface is not in this workspace. */
export async function listSurfaceCaptures(context: ProductSurfaceAccess, surfaceId: string) {
  return (await orNull(backendSDK(context).listSurfaceCaptures(surfaceId)))?.captures ?? null
}

/** Surfaces that show a feature, best first, each with why it matched; no model involved. */
export async function findSurfacesForFeature(
  context: ProductSurfaceAccess,
  input: { feature: string; limit?: number; tags?: string[] }
) {
  const { matches } = await backendSDK(context).findSurfacesForFeature(input)
  return matches.map((match) => ({ ...match, surface: fromBackend(match.surface) }))
}

/** Why a manual capture did not produce a screenshot, with the HTTP status it maps to. */
export type SurfaceCaptureFailure = { message: string; status: number }

/** Normalize a URL for matching registered surfaces (ignores fragment and trailing slash). */
function normalizeSurfaceUrl(raw: string): string {
  try {
    const parsed = new URL(raw)
    parsed.hash = ''
    const normalized = parsed.toString()
    return normalized.endsWith('/') && parsed.pathname !== '/'
      ? normalized.slice(0, -1)
      : normalized
  } catch {
    return raw.trim()
  }
}

/** Result of resolving a signed-in capture for a registered product surface URL. */
export type SignedInCaptureResolution =
  | { assetId: string; kind: 'existing' | 'captured' }
  | { jobId: string; kind: 'queued' }
  | { kind: 'unavailable' }

const FRESH_SIGNED_IN_CAPTURE_MS = 24 * 60 * 60 * 1000
const POLL_BACKOFF_MS = [1_000, 2_000, 3_000, 5_000] as const

/** True when an object key (`org/<org>/<class>/...`) holds a raw capture image. */
export function isCaptureAssetKey(objectKey: string | null | undefined): boolean {
  return objectKey?.split('/')[2] === 'capture'
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Resolves a signed-in capture when a registered surface at `url` has an active
 * recipe: reuses an existing fresh capture (< 24h) immediately, attaches to an
 * already-open job for the same recipe, or queues a capture job and waits
 * briefly (up to `pollMs`) with abort-aware backoff.
 * Returns null when `url` is an ordinary public page.
 */
export async function resolveSignedInCaptureAt(
  context: TenantContext,
  url: string,
  sourceId: string,
  {
    pollMs = 30_000,
    reuseFresh = true,
    signal,
  }: { pollMs?: number; reuseFresh?: boolean; signal?: AbortSignal } = {}
): Promise<SignedInCaptureResolution | null> {
  const sdk = backendSDK(context)
  const [{ available, jobs, recipes }, { productSurfaces }] = await Promise.all([
    sdk.captureOverview(),
    sdk.listProductSurfaces(),
  ])
  const target = normalizeSurfaceUrl(url)
  const surface = productSurfaces.find(
    (entry) =>
      normalizeSurfaceUrl(entry.url) === target &&
      Boolean(activeRecipeForSurface(recipes, entry.id))
  )
  const recipe = surface ? activeRecipeForSurface(recipes, surface.id) : undefined
  if (!surface || !recipe) return null

  if (reuseFresh) {
    // Reuse an existing fresh (< 24h) current capture of this signed-in surface when available.
    const captures = await orNull(sdk.listSurfaceCaptures(surface.id))
    const current = captures?.captures?.find((item) => !item.supersededAt)
    if (
      current &&
      Date.now() - new Date(current.capturedAt).getTime() < FRESH_SIGNED_IN_CAPTURE_MS
    ) {
      return { assetId: current.assetId, kind: 'existing' }
    }
  }

  if (!available) return { kind: 'unavailable' }
  const openJob = jobs?.find(
    (item) =>
      item.recipeId === recipe.id &&
      (item.phase === 'QUEUED' || item.phase === 'RUNNING' || item.phase === 'WAITING_DEPLOYMENT')
  )
  let job: CaptureJob
  if (openJob) {
    job = openJob
  } else {
    try {
      const response = await sdk.requestCaptureJob(recipe.id, {
        test: false,
        source: 'agent',
        sourceId,
      })
      job = response.job
    } catch (error) {
      if (error instanceof BackendSDKError && error.status === 409) return { kind: 'unavailable' }
      throw error
    }
  }

  if (job.phase === 'SUCCEEDED' && job.assetId) {
    return { assetId: job.assetId, kind: 'captured' }
  }

  const deadline = Date.now() + Math.max(0, pollMs)
  let attempt = 0
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const stepMs = POLL_BACKOFF_MS[Math.min(attempt, POLL_BACKOFF_MS.length - 1)] ?? 5_000
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await sleepWithAbort(Math.min(stepMs, remaining), signal)
    signal?.throwIfAborted()
    attempt++
    const polled = await orNull(sdk.getCaptureJob(job.id))
    const latest = polled?.job
    if (!latest) break
    if (latest.phase === 'SUCCEEDED' && latest.assetId) {
      return { assetId: latest.assetId, kind: 'captured' }
    }
    if (
      latest.phase === 'FAILED' ||
      latest.phase === 'CANCELLED' ||
      latest.phase === 'NEEDS_AUTH'
    ) {
      return { kind: 'unavailable' }
    }
  }
  return { jobId: job.id, kind: 'queued' }
}

/**
 * Queues a signed-in capture when a registered surface at this URL has an active
 * recipe, because a public screenshot of it would only show the sign-in screen.
 * Returns null when the URL is an ordinary public page.
 */
export async function queueSignedInCaptureAt(
  context: TenantContext,
  url: string,
  sourceId: string
): Promise<'queued' | 'unavailable' | null> {
  const resolved = await resolveSignedInCaptureAt(context, url, sourceId, {
    pollMs: 0,
    reuseFresh: false,
  })
  if (!resolved) return null
  if (resolved.kind === 'unavailable') return 'unavailable'
  return 'queued'
}

/**
 * Capture a surface's page now and make it the current capture. The page is
 * shot through the same SSRF-guarded screenshot service and rate limit the
 * campaign studio uses, stored as a capture asset, and recorded as a manual
 * capture, which supersedes the previous one without deleting it. An agent
 * capture records `source: 'agent'` and the run that asked for it.
 *
 * A surface with an active signed-in recipe never gets a public screenshot, which
 * would show its login screen: a capture job is queued, and its result arrives later.
 */
export async function captureProductSurface(
  context: OrganizationAccess,
  surfaceId: string,
  origin: { source: Extract<SurfaceCaptureSource, 'agent' | 'manual'>; sourceId?: string } = {
    source: 'manual',
  }
): Promise<
  { capture: SurfaceCapture } | { failure: SurfaceCaptureFailure } | { job: CaptureJob } | null
> {
  const surface = (await listProductSurfaces(context)).find((entry) => entry.id === surfaceId)
  if (!surface) return null
  const { available, recipes } = await backendSDK(context).captureOverview()
  const recipe = activeRecipeForSurface(recipes, surfaceId)
  if (recipe) {
    if (!available) {
      return {
        failure: {
          message: 'Signed-in capture is not configured on this deployment.',
          status: 503,
        },
      }
    }
    try {
      return await backendSDK(context).requestCaptureJob(recipe.id, { test: false, ...origin })
    } catch (error) {
      if (error instanceof BackendSDKError && error.status === 409) {
        return {
          failure: {
            message: 'The sign-in for this page was revoked. Connect it again in Automate.',
            status: 409,
          },
        }
      }
      throw error
    }
  }
  const limit = await checkRateLimit(
    `surface-capture:${context.organizationId}`,
    SCREENSHOT_RATE_LIMIT
  )
  if (!limit.allowed) {
    return { failure: { message: 'Screenshot capacity is used up; try again later.', status: 429 } }
  }
  let bytes: Buffer
  try {
    const { screenshot } = await captureScreenshot({
      colorScheme: 'light',
      deviceType: 'desktop',
      forceRefresh: true,
      url: surface.url,
    })
    bytes = Buffer.from(screenshot, 'base64')
  } catch (error) {
    return { failure: getScreenshotFailure(error) }
  }
  const png = await sharp(bytes).png().toBuffer({ resolveWithObject: true })
  const asset = await storeGeneratedAsset(context, {
    body: png.data,
    classification: 'capture',
    contentType: 'image/png',
    fileName: `surface-${surface.slug}.png`.slice(-128),
    height: png.info.height,
    width: png.info.width,
  })
  const capture = await backendSDK(context).recordSurfaceCapture(surfaceId, {
    assetId: asset.id,
    ...origin,
  })
  return { capture }
}
