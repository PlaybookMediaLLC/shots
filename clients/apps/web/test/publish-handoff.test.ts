import assert from 'node:assert/strict'
import test from 'node:test'
import type { TRPCClient } from '@trpc/client'
import type { AppRouter } from '@/lib/trpc/router'
import { outputFormatSchema } from '@/lib/export/formats'
import {
  compositionRevision,
  publishExportConfig,
  publishFormatChanged,
  publishableFormat,
  type PublicationRender,
  rememberPublication,
  rememberedPublication,
  uploadPublication,
} from '@/lib/platform/publish-handoff'

/**
 * The editor's half of publishing: which format a post carries, which render
 * those bytes came from, and when a render has to be stored again.
 * `renderPublication` itself draws the live stage and is covered by the
 * browser journey, not here.
 */

const config = { format: 'png', quality: 'high', scale: 2, transparent: false } as const

test('a post carries a still image, whatever the export panel is set to', () => {
  // A raster choice is kept: someone who exports JPEG for its size posts JPEG.
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    assert.equal(publishableFormat(format), format)
    assert.equal(publishFormatChanged(format), false)
  }
  // Nothing else is a still image a post can carry, and silently posting
  // a PDF or a video file as an image would fail at the provider.
  for (const format of ['svg', 'pdf', 'gif', 'mp4', 'webm'] as const) {
    assert.equal(publishableFormat(format), 'png')
    assert.equal(publishFormatChanged(format), true)
  }
  // Every format the editor offers decides one way or the other.
  for (const format of outputFormatSchema.options)
    assert.ok(['png', 'jpeg', 'webp'].includes(publishableFormat(format)))
})

test('publishing reads the export settings without changing them', () => {
  const settings = { format: 'pdf', quality: 'low', scale: 3, transparent: true } as const
  const resolved = publishExportConfig(settings)

  assert.deepEqual(resolved, { format: 'png', quality: 'low', scale: 3, transparent: true })
  // The caller's settings object is untouched: this is one export, not a
  // preference change.
  assert.deepEqual(settings, { format: 'pdf', quality: 'low', scale: 3, transparent: true })
})

test('transparency survives only into a format that has it', () => {
  // JPEG would flatten it against a colour the design never chose.
  assert.equal(
    publishExportConfig({ format: 'jpeg', quality: 'high', scale: 2, transparent: true })
      .transparent,
    false
  )
  assert.equal(
    publishExportConfig({ format: 'webp', quality: 'high', scale: 2, transparent: true })
      .transparent,
    true
  )
})

test('a render is named by the design it drew, not by the object it was read from', () => {
  const document = { background: { color: '#fff' }, image: { src: 'blob:a' }, texts: [] }
  const reordered = { texts: [], image: { src: 'blob:a' }, background: { color: '#fff' } }

  // The same design built in another key order is the same render.
  assert.equal(compositionRevision(document, config), compositionRevision(reordered, config))
  // A fresh object with the same content hits the cache; mutating in place
  // would not, which is why the key is content and never a store reference.
  assert.equal(
    compositionRevision(structuredClone(document), config),
    compositionRevision(document, config)
  )

  // An edit, and a different export of the same design, are different renders.
  assert.notEqual(
    compositionRevision(document, config),
    compositionRevision({ ...document, background: { color: '#000' } }, config)
  )
  assert.notEqual(
    compositionRevision(document, config),
    compositionRevision(document, { ...config, scale: 1 })
  )
  assert.notEqual(
    compositionRevision(document, config),
    compositionRevision(document, { ...config, format: 'jpeg' })
  )
})

/** A tRPC client that records every reservation a save makes. */
function recordingClient() {
  const reserved: {
    classification: string
    contentType: string
    fileName: string
    projectId?: string
  }[] = []
  let next = 0
  const client = {
    billing: { summary: { query: async () => ({ plan: 'pro' }) } },
    asset: {
      signUpload: {
        mutate: async (input: (typeof reserved)[number]) => {
          reserved.push(input)
          next += 1
          return { asset: { id: `asset-${next}` }, uploadUrl: 'https://storage.test/put' }
        },
      },
      completeUpload: { mutate: async () => ({ asset: {} }) },
    },
  } as unknown as TRPCClient<AppRouter>
  return { client, reserved }
}

function renderOf(revision: string): PublicationRender {
  return {
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    config,
    height: 1080,
    mimeType: 'image/png',
    revision,
    width: 1920,
  }
}

test('the same composition is stored once, however often publishing is retried', async (t) => {
  const upload = recordingClient()
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }))

  const first = await uploadPublication({
    projectId: 'project-1',
    render: renderOf('rev-1'),
    trpcClient: upload.client,
  })
  assert.deepEqual(first, { assetId: 'asset-1', revision: 'rev-1' })
  assert.equal(upload.reserved.length, 1)
  // Stored as an export of the open project, so the asset leads back to the
  // design it came from and is listed as an export rather than an upload.
  assert.equal(upload.reserved[0].classification, 'export')
  assert.equal(upload.reserved[0].projectId, 'project-1')
  assert.equal(upload.reserved[0].contentType, 'image/png')
  assert.match(upload.reserved[0].fileName, /^shots-[\w-]+\.png$/)

  // Clicking Publish again on an unchanged design attaches the asset that
  // already holds these pixels instead of leaving an orphan behind.
  const again = await uploadPublication({
    render: renderOf('rev-1'),
    reuse: first,
    trpcClient: upload.client,
  })
  assert.deepEqual(again, first)
  assert.equal(upload.reserved.length, 1)

  // An edited design is a new publication asset: the one already scheduled
  // keeps the bytes it was scheduled with.
  const edited = await uploadPublication({
    render: renderOf('rev-2'),
    reuse: first,
    trpcClient: upload.client,
  })
  assert.deepEqual(edited, { assetId: 'asset-2', revision: 'rev-2' })
  assert.equal(upload.reserved.length, 2)
  assert.equal(upload.reserved[1].classification, 'export')
})

test('reopening the publish dialog attaches the asset the last one stored', () => {
  const asset = { assetId: 'asset-1', revision: 'rev-1' }
  rememberPublication('workspace-1', asset)

  // Closing the dialog drops its own state, so the same design has to find
  // its asset here rather than storing the pixels again.
  assert.deepEqual(rememberedPublication('workspace-1', 'rev-1'), asset)
  // Any edit, and any other export, is a different publication.
  assert.equal(rememberedPublication('workspace-1', 'rev-2'), undefined)
  // An asset of another workspace is never offered: it could not be read there.
  assert.equal(rememberedPublication('workspace-2', 'rev-1'), undefined)

  rememberPublication('workspace-1', { assetId: 'asset-2', revision: 'rev-2' })
  assert.equal(rememberedPublication('workspace-1', 'rev-1'), undefined)
})
