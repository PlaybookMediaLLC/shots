import { createHash } from 'node:crypto'
import { z } from 'zod'
import { MarkdownKit } from '@shots/platejs-editor/markdown-kit'
import { createSlateEditor, KEYS, type Value } from '@shots/platejs-editor/platejs'
import { threadAsRules } from '@/lib/content-drafts/export'
import { plateBodySchema } from '@/lib/write/document'
import { creativeSetDocumentSchema, materializeOutput } from '@/lib/creative-sets/document'
import { mapDesignSources } from '@/lib/design/document'
import {
  createDesignRenderer,
  isDesignRendererAvailable,
  KIT_ASSET_PREFIX,
  type SnapshotLocalAsset,
} from '@/lib/design/renderer'

import { kitRenderRequestSchema, kitRenderOutputSchema } from './kit-render-schema'

const MAX_KIT_ASSET_TOTAL_BYTES = 100 << 20
const ASSET_FETCH_TIMEOUT_MS = 30_000
const MAX_REMOTE_ASSET_CONCURRENCY = 6

export async function fetchBoundedAssetBytes(
  signedUrl: string,
  expectedBytes: number,
  expectedSha256: string,
  parentSignal?: AbortSignal
): Promise<Buffer> {
  const parsed = new URL(signedUrl)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('A pinned asset URL is invalid.')
  }
  const timeoutSignal = AbortSignal.timeout(ASSET_FETCH_TIMEOUT_MS)
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal
  const response = await fetch(signedUrl, { redirect: 'error', signal })
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('A pinned asset could not be loaded.')
  }
  const reader = response.body.getReader()
  const hash = createHash('sha256')
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > expectedBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error('A pinned asset changed.')
      }
      hash.update(value)
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  if (received !== expectedBytes || hash.digest('hex') !== expectedSha256) {
    throw new Error('A pinned asset changed.')
  }
  return Buffer.concat(chunks, received)
}

async function fetchRemoteKitAssets(
  remotePins: ReadonlyArray<z.infer<typeof kitRenderRequestSchema>['snapshot']['assets'][number]>,
  assetUrls: Readonly<Record<string, string>>,
  localAssets: Map<string, SnapshotLocalAsset>
): Promise<void> {
  if (remotePins.length === 0) return
  const controller = new AbortController()
  let cursor = 0
  let firstError: unknown = null
  const workers = Array.from({ length: Math.min(MAX_REMOTE_ASSET_CONCURRENCY, remotePins.length) }, async () => {
    while (cursor < remotePins.length && !controller.signal.aborted) {
      const pin = remotePins[cursor++]!
      try {
        const bytes = await fetchBoundedAssetBytes(
          assetUrls[pin.id]!,
          pin.byteLength,
          pin.sha256,
          controller.signal
        )
        localAssets.set(pin.id, { bytes, mediaType: pin.mediaType })
      } catch (error) {
        if (firstError === null) firstError = error
        controller.abort()
        return
      }
    }
  })
  await Promise.all(workers)
  if (firstError !== null) throw firstError
}

/** Prepare native output using the editors' existing serializers and renderer. */
export async function renderKitSnapshot(
  input: z.infer<typeof kitRenderRequestSchema>
): Promise<z.infer<typeof kitRenderOutputSchema>> {
  const assetUrls = input.assetUrls ?? {}
  const pinnedIds = new Set<string>()
  const localAssets = new Map<string, SnapshotLocalAsset>()
  let total = 0

  for (const pin of input.snapshot.assets) {
    const inlineSource = input.assets[pin.id]
    const signedUrl = assetUrls[pin.id]
    if (inlineSource !== undefined) {
      const prefix = `data:${pin.mediaType};base64,`
      if (!inlineSource.startsWith(prefix)) throw new Error('A pinned asset is missing.')
      const bytes = Buffer.from(inlineSource.slice(prefix.length), 'base64')
      total += bytes.length
      if (
        total > MAX_KIT_ASSET_TOTAL_BYTES ||
        bytes.length !== pin.byteLength ||
        createHash('sha256').update(bytes).digest('hex') !== pin.sha256
      )
        throw new Error('A pinned asset changed.')
      pinnedIds.add(pin.id)
      if (input.snapshot.kind === 'CREATIVE') {
        localAssets.set(pin.id, { bytes, mediaType: pin.mediaType })
      }
      continue
    }
    if (!signedUrl) throw new Error('A pinned asset is missing.')
    total += pin.byteLength
    if (total > MAX_KIT_ASSET_TOTAL_BYTES) throw new Error('A pinned asset changed.')
    pinnedIds.add(pin.id)
  }

  // Creative snapshots need actual bytes to render; fetch signed URLs with bounded
  // concurrency and independently verify exact byte length and SHA-256 before Chromium.
  if (input.snapshot.kind === 'CREATIVE') {
    const remotePins = input.snapshot.assets.filter(
      (pin) => input.assets[pin.id] === undefined && assetUrls[pin.id]
    )
    await fetchRemoteKitAssets(remotePins, assetUrls, localAssets)
  }

  const raw: unknown = JSON.parse(input.snapshot.document)
  if (input.snapshot.kind === 'DRAFT') {
    // Owned images must also be present in this audience's bundle. Relative
    // paths keep exported documents independent of private signed URLs.
    const remap = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(remap)
      if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, remap(child)]))
      if (typeof value === 'string' && value.startsWith('asset:')) {
        const assetId = value.slice(6)
        const path = input.assetPaths[assetId]
        if (!path || !pinnedIds.has(assetId))
          throw new Error('Include each draft image as a screenshot for this audience.')
        return path.split('/')[1]
      }
      return value
    }
    const value = threadAsRules(plateBodySchema.parse(remap(raw)) as Value)
    const editor = createSlateEditor({ plugins: MarkdownKit, value })
    const markdown = editor.getApi({ key: KEYS.markdown }).markdown.serialize({ value })
    const bytes = Buffer.from(markdown)
    if (!bytes.length || bytes.length > 1 << 20)
      throw new Error('The prepared document exceeds the kit limit.')
    return {
      body: bytes.toString('base64'),
      mediaType: 'text/markdown; charset=utf-8',
      rendererVersion: 'shots-kit-v1',
    }
  }
  const resolve = (reference: string): string => {
    if (!reference.startsWith('asset:')) return reference
    const assetId = reference.slice(6)
    if (!localAssets.has(assetId)) throw new Error('An image was not pinned.')
    return `${KIT_ASSET_PREFIX}${encodeURIComponent(assetId)}`
  }
  const set = creativeSetDocumentSchema.parse(raw)
  const output = set.outputs.find((candidate) => candidate.id === input.snapshot.outputId)
  if (!output) throw new Error('The selected creative output is missing.')
  const document = mapDesignSources(materializeOutput(set, output), resolve)
  if (document.texts.some((text) => text.fontFamily.startsWith('google:')))
    throw new Error('Choose a bundled font before freezing the creative output.')
  if (!isDesignRendererAvailable()) throw new Error('The native renderer is unavailable.')
  const renderer = await createDesignRenderer()
  try {
    const result = await renderer.renderSnapshot(document, localAssets)
    return {
      body: result.bytes.toString('base64'),
      mediaType: 'image/png',
      rendererVersion: 'shots-kit-v1',
    }
  } finally {
    await renderer.close()
  }
}
