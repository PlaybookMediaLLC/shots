import { BackendSDKError } from 'screenshot-studio-backend-sdk'
import { getRedisClient } from '@/lib/redis'
import { cachedThumbnail, thumbnailKey } from '@/lib/workspace/thumbnail-cache'
import { NextResponse } from 'next/server'
import { backendSDK, orNull, serviceBackend } from '@/lib/backend/sdk'
import { createAssetThumbnail } from '@/lib/workspace/asset-thumbnail'
import { assetContentContract } from '@/lib/api/contracts/assets'
import { errorResponse, route } from '@/lib/api/route'
import { tenantAccess } from '@/lib/api/route-auth'
import { signAssetDownload } from '@/lib/tenant/assets'

class InvalidThumbnailError extends Error {}

const PRIVATE_REVALIDATE_CACHE = 'private, max-age=0, must-revalidate'

function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false
  return header.split(',').some((part) => {
    const value = part.trim()
    return value === etag || value.replace(/^W\//, '') === etag
  })
}

/** Returns private previews or original bytes only after Go rechecks current access. */
export const GET = route(assetContentContract, {
  auth: async (context) =>
    context.request.nextUrl.searchParams.has('downloadToken')
      ? null // The backend validates the encrypted grant before accessing storage.
      : tenantAccess({ apiKeyScope: 'artifact:read', permission: 'artifact:read' })(context),
  handler: async ({ access, params, query, headers }) => {
    if (!access) {
      const source = await serviceBackend().readAssetDownload(
        params.assetId,
        query.downloadToken ?? '',
        headers.range,
        headers['if-none-match']
      )
      const responseHeaders = new Headers({
        'cache-control': PRIVATE_REVALIDATE_CACHE,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
      })
      for (const name of [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'etag',
      ]) {
        const value = source.headers.get(name)
        if (value) responseHeaders.set(name, value)
      }
      if (source.status === 304) {
        return new Response(null, { headers: responseHeaders, status: 304 })
      }
      return new Response(source.body, { headers: responseHeaders, status: source.status })
    }
    if (query.variant === 'thumbnail') {
      const thumbnailEtag = `"thumb-${params.assetId}-v1"`
      try {
        if (matchesIfNoneMatch(headers['if-none-match'], thumbnailEtag)) {
          // Ownership, deletion, and current permissions are checked before every 304.
          if (!(await signAssetDownload(access, params.assetId))) {
            throw new BackendSDKError('Asset not found.', 404)
          }
          return new Response(null, {
            headers: {
              'cache-control': PRIVATE_REVALIDATE_CACHE,
              etag: thumbnailEtag,
            },
            status: 304,
          })
        }
        const thumbnail = await cachedThumbnail(
          thumbnailKey(access.organizationId, params.assetId),
          async () => {
            // Ownership, deletion, and current permissions are checked even on cache hits.
            if (!(await signAssetDownload(access, params.assetId))) {
              throw new BackendSDKError('Asset not found.', 404)
            }
          },
          async () => {
            const body = await orNull(backendSDK(access).readAsset(params.assetId))
            if (!body) throw new BackendSDKError('Asset not found.', 404)
            try {
              return await createAssetThumbnail(body)
            } catch {
              throw new InvalidThumbnailError('Preview unavailable for this asset.')
            }
          },
          async () => (await getRedisClient()).withCommandOptions({ timeout: 1_000 })
        )
        return new Response(new Uint8Array(thumbnail), {
          headers: {
            'cache-control': PRIVATE_REVALIDATE_CACHE,
            'content-type': 'image/webp',
            etag: thumbnailEtag,
          },
        })
      } catch (error) {
        if (error instanceof InvalidThumbnailError) return errorResponse(422, error.message)
        throw error
      }
    }
    const downloadUrl = await signAssetDownload(access, params.assetId)
    if (!downloadUrl) return errorResponse(404, 'Asset not found.')
    const response = NextResponse.redirect(downloadUrl, 302)
    // The signed URL expires; never let a cache keep the redirect.
    response.headers.set('cache-control', 'private, no-store')
    return response
  },
})
