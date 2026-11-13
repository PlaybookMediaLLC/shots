import 'server-only'

import { createHash } from 'node:crypto'
import { BackendSDKError } from 'screenshot-studio-backend-sdk'
import { backendSDK, orNull } from '@/lib/backend/sdk'
import type { TenantContext } from '@/lib/auth/access'
import type { AssetClassification } from './object-key'
import type { AssetUploadInput } from './schemas'

export type AssetDeletionResult = 'deleted' | 'in-use' | 'not-found' | 'not-ready'

/**
 * The backend checks the storage quota, records a PENDING asset row, and signs
 * a short-lived upload URL for its private object key.
 */
export async function signAssetUpload(context: TenantContext, input: AssetUploadInput) {
  return backendSDK(context).signAssetUpload(input)
}

/**
 * Reserve an upload the browser may send in parts: a file larger than one
 * part comes back with its part plan instead of a single signed URL.
 */
export async function signAssetUploadInParts(context: TenantContext, input: AssetUploadInput) {
  return backendSDK(context).signAssetUploadInParts(input)
}

/** The parts of a multipart upload storage holds, and signed PUTs for `parts`. */
export async function signAssetUploadParts(
  context: TenantContext,
  assetId: string,
  parts: number[]
) {
  return backendSDK(context).signAssetUploadParts(assetId, parts)
}

export async function completeAssetUpload(
  context: TenantContext,
  assetId: string,
  sha256?: string,
  partSha256?: string[]
) {
  const result = await orNull(backendSDK(context).completeAssetUpload(assetId, sha256, partSha256))
  return result?.asset ?? null
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Above this, a file goes in parts, as `saveExportToWorkspace` sends one. */
const PART_BYTES = 16 * 1024 * 1024

/**
 * Store bytes the server fetched (an import) as an input asset, through the
 * same reservation, signed upload and Go completion checks as a browser
 * upload: a large file in parts, each with its digest.
 */
export async function storeFetchedAsset(
  context: TenantContext,
  file: { bytes: Uint8Array; contentType: string; fileName: string }
) {
  const put = async (url: string, body: Uint8Array, headers: Record<string, string>) => {
    const response = await fetch(url, {
      body: new Uint8Array(body),
      headers,
      method: 'PUT',
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok) throw new Error('The file could not be saved. Try again.')
  }
  const reservation = {
    bytes: file.bytes.length,
    classification: 'input' as const,
    contentType: file.contentType,
    fileName: file.fileName,
  }
  if (file.bytes.length <= PART_BYTES) {
    const digest = sha256(file.bytes)
    const signed = await signAssetUpload(context, { ...reservation, sha256: digest })
    // The signed URL is write-once; the header is part of its signature.
    await put(signed.uploadUrl, file.bytes, {
      'content-type': file.contentType,
      'if-none-match': '*',
    })
    return completeAssetUpload(context, signed.asset.id, digest)
  }
  const signed = await signAssetUploadInParts(context, reservation)
  if (!signed.multipart) throw new Error('Storage did not accept a file this large. Try again.')
  const { partBytes, parts } = signed.multipart
  const digests: string[] = []
  for (let number = 1; number <= parts; number++) {
    const part = file.bytes.subarray((number - 1) * partBytes, number * partBytes)
    digests.push(sha256(part))
    const { urls } = await signAssetUploadParts(context, signed.asset.id, [number])
    await put(urls[0]!.url, part, {})
  }
  return completeAssetUpload(context, signed.asset.id, undefined, digests)
}

export async function signAssetDownload(
  context: TenantContext,
  assetId: string
): Promise<string | null> {
  return (await orNull(backendSDK(context).signAssetDownload(assetId)))?.downloadUrl ?? null
}

export async function listAssets(
  context: TenantContext,
  options: {
    search?: string
    classification?: string
    cursor?: string
    take: number
    type?: 'all' | 'image' | 'video'
    sort?: 'newest' | 'oldest'
  }
) {
  const page = await backendSDK(context).listAssets({
    cursor: options.cursor,
    search: options.search,
    classification: options.classification,
    limit: options.take,
    type: options.type,
    sort: options.sort,
  })
  return {
    assets: page.assets.map((item) => ({ ...item, createdAt: new Date(item.createdAt) })),
    nextCursor: page.nextCursor,
  }
}

/**
 * The backend resolves ownership before the asset:delete plan gate, so a
 * workspace that cannot see the asset gets 'not-found', never an entitlement
 * error that would confirm the id exists in another workspace.
 */
export async function deleteAsset(
  context: TenantContext,
  assetId: string
): Promise<AssetDeletionResult> {
  try {
    await backendSDK(context).deleteAsset(assetId)
    return 'deleted'
  } catch (error) {
    if (error instanceof BackendSDKError && error.status === 404) return 'not-found'
    if (error instanceof BackendSDKError && error.status === 409) {
      return error.message.includes('in use') ? 'in-use' : 'not-ready'
    }
    throw error
  }
}

export async function storeGeneratedAsset(
  context: TenantContext,
  input: {
    body: Uint8Array
    classification: AssetClassification
    contentType: 'image/jpeg' | 'image/png' | 'image/webp'
    fileName: string
    height: number
    parentAssetId?: string
    width: number
  }
) {
  return backendSDK(context).storeGeneratedAsset(input)
}

/** Describe an image (RFC 025); null when it is not this workspace's. */
export async function setAssetAltText(context: TenantContext, assetId: string, altText: string) {
  return orNull(backendSDK(context).setAssetAltText(assetId, altText))
}
