import assert from 'node:assert/strict'
import test from 'node:test'
import type { TRPCClient } from '@trpc/client'
import { designCatalog } from '@/lib/design/catalog'
import {
  DESIGN_DOCUMENT_VERSION,
  designDocumentSchema,
  type DesignDocument,
} from '@/lib/design/document'
import { clearAssetUrlCache, fetchAssetUrl, fetchDesignSources } from '@/lib/design/open-design'
import { useImageStore } from '@/lib/store'
import type { AppRouter } from '@/lib/trpc/router'

function assetId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

function docWithAssets(ids: string[]): DesignDocument {
  // Spread across slides (max 60), overlays (max 40), devices.mockups (max 6), main image, and background.
  const slides = ids.slice(0, 60).map((id, i) => ({
    duration: 2,
    id: `slide-${i}`,
    name: null,
    src: `asset:${id}`,
  }))
  const overlays = ids.slice(60, 100).map((id, i) => ({
    id: `overlay-${i}`,
    position: { x: 0.5, y: 0.5 },
    size: 0.2,
    src: `asset:${id}`,
  }))
  const mockups = ids.slice(100, 106).map((id, i) => ({
    definitionId: designCatalog.mockups[0].id,
    id: `mockup-${i}`,
    position: { x: 0.5, y: 0.5 },
    screen: { src: `asset:${id}` },
    size: 0.4,
  }))
  return designDocumentSchema.parse({
    background: ids[107] ? { type: 'image', value: `asset:${ids[107]}` } : undefined,
    devices: mockups.length > 0 ? { mockups } : undefined,
    image: { src: ids[106] ? `asset:${ids[106]}` : null },
    overlays,
    slides: slides.length > 0 ? { items: slides } : undefined,
    version: DESIGN_DOCUMENT_VERSION,
  })
}

function mockBlobEnvironment(t: test.TestContext) {
  let seq = 0
  const revoked: string[] = []
  t.mock.method(URL, 'createObjectURL', () => `blob:test-${++seq}`)
  t.mock.method(URL, 'revokeObjectURL', (url: string) => {
    revoked.push(url)
  })
  t.mock.method(globalThis, 'fetch', async () => new Response(new Blob(['img'])))
  t.after(() => {
    useImageStore.setState(useImageStore.getInitialState(), true)
    useImageStore.temporal.getState().clear()
    clearAssetUrlCache()
  })
  return { revoked }
}

function mockTRPC(options: {
  batchCalls: string[][]
  singleCalls: string[]
  failIds?: Set<string>
}): TRPCClient<AppRouter> {
  return {
    asset: {
      signDownload: {
        query: async ({ assetId: id }: { assetId: string }) => {
          options.singleCalls.push(id)
          if (options.failIds?.has(id)) throw new Error(`sign failed for ${id}`)
          return { downloadUrl: `https://downloads.test/${id}` }
        },
      },
      signDownloads: {
        query: async ({ assetIds }: { assetIds: string[] }) => {
          options.batchCalls.push([...assetIds])
          const urls: Record<string, string> = {}
          for (const id of assetIds) {
            if (!options.failIds?.has(id)) urls[id] = `https://downloads.test/${id}`
          }
          return { urls }
        },
      },
    },
  } as unknown as TRPCClient<AppRouter>
}

test('fetchDesignSources batch-signs in chunks of <= 100 and reuses cached entries', async (t) => {
  mockBlobEnvironment(t)
  const batchCalls: string[][] = []
  const singleCalls: string[] = []
  const trpc = mockTRPC({ batchCalls, singleCalls })

  const ids = Array.from({ length: 105 }, (_, i) => assetId(i + 1))
  const first = await fetchDesignSources(trpc, docWithAssets(ids))

  assert.equal(Object.keys(first).length, 105)
  assert.deepEqual(
    batchCalls.map((chunk) => chunk.length),
    [100, 5]
  )
  assert.equal(singleCalls.length, 0)

  // Re-fetching a subset hits the cache with zero extra RPCs.
  const second = await fetchDesignSources(trpc, docWithAssets(ids.slice(0, 3)))
  assert.equal(second[`asset:${ids[0]}`], first[`asset:${ids[0]}`])
  assert.equal(batchCalls.length, 2)
  assert.equal(singleCalls.length, 0)
})

test('LRU eviction revokes settled unreachable blobs while preserving active and undo-history blobs', async (t) => {
  const { revoked } = mockBlobEnvironment(t)
  const batchCalls: string[][] = []
  const singleCalls: string[] = []
  const trpc = mockTRPC({ batchCalls, singleCalls })

  const activeId = assetId(1)
  const historyId = assetId(2)
  const evictableId = assetId(3)
  const activeUrl = await fetchAssetUrl(trpc, activeId)
  const historyUrl = await fetchAssetUrl(trpc, historyId)
  const evictableUrl = await fetchAssetUrl(trpc, evictableId)

  // Place historyUrl in undo history and activeUrl in live state.
  useImageStore.setState({ uploadedImageUrl: historyUrl })
  useImageStore.setState({ uploadedImageUrl: activeUrl })

  // Load 55 more assets so the cache exceeds MAX_ASSET_URLS (50).
  const overflowIds = Array.from({ length: 55 }, (_, i) => assetId(10 + i))
  await fetchDesignSources(trpc, docWithAssets(overflowIds))

  assert.ok(revoked.includes(evictableUrl), 'unreferenced older blob URL should be revoked')
  assert.ok(!revoked.includes(activeUrl), 'active canvas blob URL must not be revoked')
  assert.ok(!revoked.includes(historyUrl), 'undo-history blob URL must not be revoked')
})

test('failed asset fetches are evicted from the cache so subsequent retries succeed', async (t) => {
  mockBlobEnvironment(t)
  const failIds = new Set([assetId(500)])
  const batchCalls: string[][] = []
  const singleCalls: string[] = []
  const trpc = mockTRPC({ batchCalls, singleCalls, failIds })

  await assert.rejects(() => fetchAssetUrl(trpc, assetId(500)), /sign failed/)
  failIds.clear()
  const recovered = await fetchAssetUrl(trpc, assetId(500))
  assert.match(recovered, /^blob:test-/)
  assert.equal(singleCalls.length, 2)
})
