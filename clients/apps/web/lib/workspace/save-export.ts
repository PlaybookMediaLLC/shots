'use client'

import type { TRPCClient } from '@trpc/client'
import { uploadByteLimit } from '@/lib/write/media-limits'
import { captureVideoPoster } from './video-poster'
import type { AppRouter } from '@/lib/trpc/router'

/**
 * Save an editor export into the signed-in user's workspace.
 *
 * The editor is otherwise standalone: it keeps drafts in IndexedDB and
 * delivers exports as browser downloads, so nothing it produces reaches
 * the platform. This is the seam between the two, turning an export into
 * a tenant asset that campaigns, variants, and releases can reference.
 *
 * Upload runs against a presigned URL rather than through the
 * application, so image and video payloads never occupy a server request.
 * The flow mirrors the API that already backs programmatic uploads:
 * reserve an asset, PUT the bytes, then mark it complete.
 */

/** Matches the content types the tenant asset schema accepts. */
const SUPPORTED_CONTENT_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  // QuickTime from phones and cameras; Instagram and Threads take it as is.
  'video/quicktime',
  'video/webm',
  // Audio for design timelines.
  'audio/aac',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'font/woff',
  'font/woff2',
  'font/ttf',
  'font/otf',
  // LinkedIn documents (RFC 025).
  'application/pdf',
])

export interface SaveToWorkspaceInput {
  onProgress?: (progress: number) => void
  /**
   * Called with the reserved asset before any bytes move, so a caller can
   * record it and recognize an interrupted upload after a reload.
   */
  onReserved?: (assetId: string) => void | Promise<void>
  parentAssetId?: string
  projectId?: string
  classification?: 'input' | 'export' | 'derived' | 'capture' | 'poster'
  blob: Blob
  fileName: string
  trpcClient: TRPCClient<AppRouter>
  /**
   * The reservation an interrupted upload of this same file made. When it
   * is sent in parts, only the parts storage does not hold are sent again;
   * otherwise this throws and the caller starts a new upload.
   */
  resumeAssetId?: string
}

export interface SavedAsset {
  assetId: string
}

export class WorkspaceSaveError extends Error {
  constructor(
    message: string,
    readonly code: 'unsupported-type' | 'too-large' | 'upload-failed' | 'not-signed-in'
  ) {
    super(message)
    this.name = 'WorkspaceSaveError'
  }
}

/**
 * Hex-encoded SHA-256 of the payload.
 *
 * The API accepts a digest and uses it to confirm that the bytes that
 * arrived are the bytes that were intended, which catches a truncated or
 * corrupted upload at completion rather than when the asset is later
 * rendered into an artifact.
 */
async function digestBlob(blob: Blob): Promise<string | undefined> {
  // Subtle crypto requires a secure context. Local HTTP development is
  // the common case where it is absent, and the digest is optional
  // server-side, so a missing implementation weakens verification rather
  // than blocking the save.
  // Avoid a second full-sized allocation for large video uploads. Go still
  // streams and verifies the exact reserved byte count at completion.
  if (!globalThis.crypto?.subtle || blob.size > 64 * 1024 * 1024) {
    return undefined
  }

  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function assertSupported(blob: Blob, plan: string): void {
  if (!SUPPORTED_CONTENT_TYPES.has(blob.type)) {
    throw new WorkspaceSaveError(
      `Workspace assets do not support ${blob.type || 'this file type'}.`,
      'unsupported-type'
    )
  }

  const limit = uploadByteLimit(blob.type, plan)
  if (blob.size > limit) {
    throw new WorkspaceSaveError(
      `This file is larger than your plan's ${limit / 1_000_000} MB asset limit.`,
      'too-large'
    )
  }
}

/**
 * The server's part size (uploadPartBytes in Go): a larger file goes in
 * parts, so a dropped connection resends one part and the browser never
 * holds the whole file in memory.
 */
const PART_BYTES = 16 * 1024 * 1024

export async function saveExportToWorkspace(input: SaveToWorkspaceInput): Promise<SavedAsset> {
  const { blob, fileName, trpcClient } = input
  // The server finishes a file sent in parts only with each part's digest,
  // and Web Crypto needs a secure context: refuse before reserving or sending.
  if (blob.size > PART_BYTES && !globalThis.crypto?.subtle) {
    throw new WorkspaceSaveError(
      'Files over 16 MB upload only over a secure (HTTPS) connection.',
      'too-large'
    )
  }
  if (input.resumeAssetId) {
    const partSha256 = await sendParts(trpcClient, input.resumeAssetId, blob, input.onProgress)
    await trpcClient.asset.completeUpload.mutate({ assetId: input.resumeAssetId, partSha256 })
    return { assetId: input.resumeAssetId }
  }
  // Read the current entitlement for each transfer: a stale browser session must
  // not advertise a paid upload ceiling after a workspace/plan change.
  const { plan } = await trpcClient.billing.summary.query()
  assertSupported(blob, plan)

  const large = blob.size > PART_BYTES
  // A large file is checked part by part instead; the server records its digest.
  const sha256 = large ? undefined : await digestBlob(blob)
  const reservation = {
    bytes: blob.size,
    classification: input.classification ?? 'input',
    projectId: input.projectId,
    parentAssetId: input.parentAssetId,
    contentType: blob.type,
    fileName,
    sha256,
  } as const
  const { asset, uploadUrl, multipart } = large
    ? await trpcClient.asset.signUploadInParts.mutate(reservation)
    : { ...(await trpcClient.asset.signUpload.mutate(reservation)), multipart: undefined }

  await input.onReserved?.(asset.id)
  if (multipart) {
    const partSha256 = await sendParts(trpcClient, asset.id, blob, input.onProgress)
    await trpcClient.asset.completeUpload.mutate({ assetId: asset.id, partSha256 })
  } else {
    // The signed URL is write-once; storage refuses a second PUT.
    await uploadWithProgress(uploadUrl, blob, WRITE_ONCE, percent(blob.size, input.onProgress))
    await trpcClient.asset.completeUpload.mutate({ assetId: asset.id, sha256 })
  }
  if (blob.type.startsWith('video/')) await savePoster(blob, asset.id, trpcClient)

  return { assetId: asset.id }
}

/**
 * Store the video's opening frame beside it. The video is already saved, and
 * lists fall back to the browser's own first frame, so a failure stops nothing.
 */
async function savePoster(
  video: Blob,
  parentAssetId: string,
  trpcClient: TRPCClient<AppRouter>
): Promise<void> {
  try {
    const poster = await captureVideoPoster(video)
    if (poster)
      await saveExportToWorkspace({
        blob: poster,
        classification: 'poster',
        fileName: 'poster.jpg',
        parentAssetId,
        trpcClient,
      })
  } catch (error) {
    console.warn('The video poster was not saved.', error)
  }
}

/**
 * Send a reserved file in parts, skipping the parts storage already holds,
 * and return each part's SHA-256 for the server to check against what it
 * stored. One part is in memory at a time; a part that fails is sent again
 * with a fresh URL, twice at most, since storage replaces a part sent again.
 */
async function sendParts(
  trpcClient: TRPCClient<AppRouter>,
  assetId: string,
  blob: Blob,
  onProgress?: (progress: number) => void
): Promise<string[] | undefined> {
  const plan = await trpcClient.asset.uploadParts.mutate({ assetId, parts: [] })
  const stored = new Set(plan.uploaded)
  const digests: (string | undefined)[] = []
  let sent = 0
  for (let number = 1; number <= plan.parts; number++) {
    const part = blob.slice((number - 1) * plan.partBytes, number * plan.partBytes)
    digests.push(await digestBlob(part))
    for (let attempt = 1; !stored.has(number); attempt++) {
      const { urls } = await trpcClient.asset.uploadParts.mutate({ assetId, parts: [number] })
      try {
        await uploadWithProgress(
          urls[0].url,
          part,
          {},
          onProgress && ((loaded) => percent(blob.size, onProgress)?.(sent + loaded))
        )
        break
      } catch (error) {
        if (attempt === 3) throw error
      }
    }
    sent += part.size
    onProgress?.(Math.round((sent / blob.size) * 95))
  }
  // Every part has a digest: saveExportToWorkspace refuses large files without Web Crypto.
  return digests.every(Boolean) ? (digests as string[]) : undefined
}

/** Headers a single signed PUT carries: both are part of its signature. */
const WRITE_ONCE = { 'if-none-match': '*' }

/** Report bytes sent as a percentage of `total`, held under 95 until the server confirms. */
function percent(total: number, onProgress?: (progress: number) => void) {
  return (
    onProgress && ((loaded: number) => onProgress(Math.min(95, Math.round((loaded / total) * 95))))
  )
}

/**
 * A file name object keys accept: letters, digits, dots, dashes and
 * underscores, starting with a letter or digit, at most 128 characters.
 * Empty when nothing of the name is left.
 */
export function safeAssetFileName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^[^a-zA-Z0-9]+/, '')
    .slice(0, 128)
}

/**
 * Filename for a saved export.
 *
 * Saved assets are listed alongside one another, so a timestamp keeps
 * successive exports of the same composition distinguishable without
 * requiring the user to name each one.
 */
export function buildExportFileName(contentType: string, now = new Date()): string {
  const extension = contentType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `shots-${stamp}.${extension}`
}

/**
 * PUT bytes to a signed URL with `headers`; `onLoaded` gets the bytes sent so
 * far. Completion still waits for Go verification.
 */
async function uploadWithProgress(
  url: string,
  blob: Blob,
  headers: Record<string, string>,
  onLoaded?: (loaded: number) => void
): Promise<void> {
  if (!onLoaded || typeof XMLHttpRequest === 'undefined') {
    const response = await fetch(url, {
      body: blob,
      headers: { 'content-type': blob.type, ...headers },
      method: 'PUT',
    })
    if (!response.ok)
      throw new WorkspaceSaveError(`Upload failed with status ${response.status}.`, 'upload-failed')
    return
  }
  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('PUT', url)
    request.setRequestHeader('content-type', blob.type)
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value)
    request.timeout = 15 * 60 * 1000
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onLoaded(event.loaded)
    }
    const fail = () =>
      reject(
        new WorkspaceSaveError(
          'Upload failed. Your text is saved; retry the attachment.',
          'upload-failed'
        )
      )
    request.onerror = fail
    request.ontimeout = fail
    request.onabort = fail
    request.onload = () => (request.status >= 200 && request.status < 300 ? resolve() : fail())
    request.send(blob)
  })
}
