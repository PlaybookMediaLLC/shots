'use client'

import type { TRPCClient } from '@trpc/client'
import {
  beginHistoryStep,
  collectReachableBlobUrls,
  endHistoryStep,
  useImageStore,
} from '@/lib/store'
import type { AppRouter } from '@/lib/trpc/router'
import {
  applyDesignDocument,
  applyDesignLayout,
  type DesignHistoryMode,
  layoutCanvasSize,
} from './apply'
import { type DesignDocument, getDesignAssetIds } from './document'

/** Workspace images fetched on this page, by asset id. Assets never change bytes. */
const MAX_ASSET_URLS = 50
const MAX_SIGN_BATCH = 100

interface AssetCacheEntry {
  promise: Promise<string>
  settled: boolean
  url?: string
}

const assetUrls = new Map<string, AssetCacheEntry>()

function evictOldestAssetUrls(protectedIds?: ReadonlySet<string>) {
  if (assetUrls.size <= MAX_ASSET_URLS) return
  const reachable = collectReachableBlobUrls()
  for (const [key, entry] of assetUrls) {
    if (assetUrls.size <= MAX_ASSET_URLS) break
    if (!entry.settled || protectedIds?.has(key)) continue
    if (entry.url && reachable.has(entry.url)) continue
    assetUrls.delete(key)
    if (entry.url?.startsWith('blob:') && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(entry.url)
    }
  }
}

/** Clear cached asset blob URLs (revoking settled, unreachable entries). */
export function clearAssetUrlCache() {
  const reachable = collectReachableBlobUrls()
  for (const [key, entry] of assetUrls) {
    assetUrls.delete(key)
    if (
      entry.settled &&
      entry.url?.startsWith('blob:') &&
      !reachable.has(entry.url) &&
      typeof URL !== 'undefined' &&
      typeof URL.revokeObjectURL === 'function'
    ) {
      URL.revokeObjectURL(entry.url)
    }
  }
}

async function fetchBlobUrl(downloadUrl: string): Promise<string> {
  const response = await fetch(downloadUrl)
  if (!response.ok) throw new Error(`The download failed with status ${response.status}.`)
  return URL.createObjectURL(await response.blob())
}

function registerAssetPromise(
  assetId: string,
  promise: Promise<string>,
  options: { evict?: boolean; protectedIds?: ReadonlySet<string> } = {}
): Promise<string> {
  const entry: AssetCacheEntry = { promise, settled: false }
  const tracked = promise.then(
    (url) => {
      entry.settled = true
      entry.url = url
      return url
    },
    (error) => {
      entry.settled = true
      if (assetUrls.get(assetId) === entry) assetUrls.delete(assetId)
      throw error
    }
  )
  // Keep callers observing the same settled rejection without unhandled-rejection noise on background registration.
  tracked.catch(() => undefined)
  entry.promise = tracked
  assetUrls.set(assetId, entry)
  if (options.evict !== false) {
    evictOldestAssetUrls(options.protectedIds)
  }
  return tracked
}

/** A workspace image as a blob URL, fetched once per page with bounded LRU eviction. */
export function fetchAssetUrl(trpcClient: TRPCClient<AppRouter>, assetId: string) {
  const cached = assetUrls.get(assetId)
  if (cached) {
    // Refresh LRU recency.
    assetUrls.delete(assetId)
    assetUrls.set(assetId, cached)
    return cached.promise
  }
  const url = (async () => {
    const { downloadUrl } = await trpcClient.asset.signDownload.query({ assetId })
    return fetchBlobUrl(downloadUrl)
  })()
  return registerAssetPromise(assetId, url)
}

/**
 * Fetch every workspace image a document names into a blob URL, keyed by its
 * `asset:<id>` reference, so the editor's export never sees a cross-origin image.
 * Uncached multi-asset documents batch-sign their URLs in chunks of up to 100.
 */
export async function fetchDesignSources(
  trpcClient: TRPCClient<AppRouter>,
  document: DesignDocument
): Promise<Record<string, string>> {
  const ids = getDesignAssetIds(document)
  const protectedIds = new Set(ids)
  // Refresh LRU recency for every asset already cached before checking misses.
  for (const id of ids) {
    const existing = assetUrls.get(id)
    if (existing) {
      assetUrls.delete(id)
      assetUrls.set(id, existing)
    }
  }
  const missing = ids.filter((id) => !assetUrls.has(id))
  if (missing.length > 1) {
    for (let offset = 0; offset < missing.length; offset += MAX_SIGN_BATCH) {
      const chunk = missing.slice(offset, offset + MAX_SIGN_BATCH)
      if (chunk.length === 1) {
        const assetId = chunk[0]
        if (!assetUrls.has(assetId)) {
          const url = (async () => {
            const { downloadUrl } = await trpcClient.asset.signDownload.query({ assetId })
            return fetchBlobUrl(downloadUrl)
          })()
          registerAssetPromise(assetId, url, { evict: false, protectedIds })
        }
        continue
      }
      const signedPromise = trpcClient.asset.signDownloads.query({ assetIds: chunk })
      for (const assetId of chunk) {
        if (assetUrls.has(assetId)) continue
        const url = signedPromise.then(({ urls }) => {
          const downloadUrl = urls[assetId]
          if (!downloadUrl) throw new Error(`Asset ${assetId} was not found.`)
          return fetchBlobUrl(downloadUrl)
        })
        registerAssetPromise(assetId, url, { evict: false, protectedIds })
      }
    }
    evictOldestAssetUrls(protectedIds)
  }
  const entries = await Promise.all(
    ids.map(
      async (assetId) => [`asset:${assetId}`, await fetchAssetUrl(trpcClient, assetId)] as const
    )
  )
  evictOldestAssetUrls(protectedIds)
  return Object.fromEntries(entries)
}

/**
 * Write a stored document into the editor, workspace images included, and
 * return the blob URL each `asset:` reference was loaded as.
 *
 * `history: 'clear'` makes the document the new starting point (deep links);
 * `'step'` makes it one undoable step (an AI variation, a restored version).
 * `replace` also removes a main image the document does not have, so the
 * editor shows exactly the document rather than keeping the current screenshot.
 */
export function applyStoredDocument(
  trpcClient: TRPCClient<AppRouter>,
  document: DesignDocument,
  history: DesignHistoryMode = 'clear',
  options: { replace?: boolean; signal?: AbortSignal } = {}
): Promise<Record<string, string>> {
  // One at a time: two applies in flight would interleave their writes and steps.
  const run = applying.then(() => applyNow(trpcClient, document, history, options))
  applying = run.catch(() => undefined)
  return run
}

/** The apply in flight, if any; the next one waits for it. */
let applying: Promise<unknown> = Promise.resolve()

async function applyNow(
  trpcClient: TRPCClient<AppRouter>,
  document: DesignDocument,
  history: DesignHistoryMode,
  { replace = false, signal }: { replace?: boolean; signal?: AbortSignal }
): Promise<Record<string, string>> {
  const sources = await fetchDesignSources(trpcClient, document)
  signal?.throwIfAborted()
  const resolve = (ref: string) => sources[ref] ?? ref
  const step = history === 'step' ? beginHistoryStep() : null
  // Layout application may keep the editor's screenshot; full documents never do.
  const currentImage = !replace && !document.image.src ? useImageStore.getState().uploadedImageUrl : null
  applyDesignDocument(currentImage ? { ...document, image: { ...document.image, src: currentImage } } : document, resolve, history)
  const canvas = await layoutCanvasSize()
  signal?.throwIfAborted()
  applyDesignLayout(document, resolve, canvas, history)
  if (step) endHistoryStep(step)
  return sources
}

/** Open a stored design in the editor. See {@link applyStoredDocument} for `history`. */
export async function openDesignInEditor(
  trpcClient: TRPCClient<AppRouter>,
  designId: string,
  history: DesignHistoryMode = 'clear'
) {
  const { design } = await trpcClient.design.get.query({ designId })
  await applyStoredDocument(trpcClient, design.document, history)
  return design
}
