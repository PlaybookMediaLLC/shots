import assert from 'node:assert/strict'
import test from 'node:test'
import type { TRPCClient } from '@trpc/client'
import type { AppRouter } from '@/lib/trpc/router'
import { outputFormatSchema } from '@/lib/export/formats'
import {
  dismissIncomingMedia,
  incomingMedia,
  retryIncomingMedia,
  startIncomingMedia,
  takeIncomingMedia,
} from '@/lib/platform/incoming-media'
import {
  compositionRevision,
  publishExportConfig,
  publishKindLabel,
  publishKinds,
  publishableFormat,
  type PublicationNode,
  type PublicationRender,
  rememberPublication,
  rememberedPublication,
  uploadPublication,
} from '@/lib/platform/publish-handoff'

/**
 * The editor's half of publishing: what a design can be published as, which
 * format a post carries, which render those bytes came from, when a render has
 * to be stored again, and how exports reach the open draft.
 * `renderPublications` itself draws the live stage and runs the encoders, so
 * the browser journey covers it, not this file.
 */

const config = { format: 'png', quality: 'high', scale: 2, transparent: false } as const

test('a design offers every kind it can publish, the canvas image first', () => {
  assert.deepEqual(publishKinds({ canAnimate: false, slideCount: 0 }), ['image'])
  // One slide is just the image; two or more are a carousel.
  assert.deepEqual(publishKinds({ canAnimate: false, slideCount: 1 }), ['image'])
  assert.deepEqual(publishKinds({ canAnimate: false, slideCount: 3 }), ['image', 'slides'])
  // Motion, a timeline or slides play: video and GIF, as Export offers them.
  assert.deepEqual(publishKinds({ canAnimate: true, slideCount: 3 }), [
    'image',
    'slides',
    'video',
    'gif',
  ])
  assert.equal(publishKindLabel('slides', 3), 'All 3 slides')
  assert.equal(publishKindLabel('video', 0), 'Video (MP4)')
})

test('a still post carries a still image, whatever the export panel is set to', () => {
  // A raster choice is kept: someone who exports JPEG for its size posts JPEG.
  for (const format of ['png', 'jpeg', 'webp'] as const)
    assert.equal(publishableFormat(format), format)
  // Nothing else is a still image a post can carry; video and GIF publish
  // through their own kinds, not as a still format.
  for (const format of ['svg', 'pdf', 'gif', 'mp4', 'webm'] as const)
    assert.equal(publishableFormat(format), 'png')
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
    mimeType: 'image/png',
    revision,
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

test('publishing an unchanged design again attaches the assets already stored', () => {
  const asset = { assetId: 'asset-1', revision: 'rev-1' }
  rememberPublication('workspace-1', asset)
  // A carousel stores one asset per slide; all of them stay remembered.
  rememberPublication('workspace-1', { assetId: 'asset-2', revision: 'rev-1-slide-2' })

  assert.deepEqual(rememberedPublication('workspace-1', 'rev-1'), asset)
  assert.deepEqual(rememberedPublication('workspace-1', 'rev-1-slide-2'), {
    assetId: 'asset-2',
    revision: 'rev-1-slide-2',
  })
  // Any edit, and any other export, is a different publication.
  assert.equal(rememberedPublication('workspace-1', 'rev-2'), undefined)
  // An asset of another workspace is never offered: it could not be read there.
  assert.equal(rememberedPublication('workspace-2', 'rev-1'), undefined)

  // The memory is bounded; the oldest goes first.
  for (let index = 0; index < 40; index++)
    rememberPublication('workspace-1', { assetId: `filler-${index}`, revision: `filler-${index}` })
  assert.equal(rememberedPublication('workspace-1', 'rev-1'), undefined)
  assert.ok(rememberedPublication('workspace-1', 'filler-39'))
})

const node = (id: string): PublicationNode => ({
  assetId: id,
  children: [{ text: '' }],
  mimeType: 'image/png',
  type: 'img',
  url: `/api/v1/assets/${id}/content`,
})

/** Let queued exports settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('exports reach the open draft once each, in the order they were started', async () => {
  const draft = 'draft-order'
  let finishVideo: (nodes: PublicationNode[]) => void = () => {}
  startIncomingMedia(
    draft,
    'Video (MP4)',
    (report) =>
      new Promise((resolve) => {
        report(40)
        finishVideo = resolve
      })
  )
  startIncomingMedia(draft, 'Image', async () => [node('image')])
  await settle()

  // The video is still encoding: it reports progress and nothing is attachable yet.
  assert.deepEqual(
    incomingMedia(draft).map((job) => [job.label, job.state, job.progress]),
    [
      ['Video (MP4)', 'working', 40],
      ['Image', 'working', 0],
    ]
  )
  assert.deepEqual(takeIncomingMedia(draft), [])

  // Exports run one at a time: they share one stage and one encoder.
  finishVideo([node('video')])
  await settle()
  await settle()
  assert.deepEqual(
    takeIncomingMedia(draft).map((item) => item.assetId),
    ['video', 'image']
  )
  // Taken once: a composer that renders again cannot insert them twice.
  assert.deepEqual(takeIncomingMedia(draft), [])
  // Another draft's exports are its own.
  assert.deepEqual(incomingMedia('another-draft'), [])
})

test('a failed export says why, can run again, and is attached only when it succeeds', async () => {
  const draft = 'draft-failure'
  let attempts = 0
  const id = startIncomingMedia(draft, 'GIF', async () => {
    attempts += 1
    if (attempts === 1) throw new Error('Upload failed. Your text is saved; retry the attachment.')
    return [node('gif')]
  })
  await settle()
  assert.deepEqual(
    incomingMedia(draft).map((job) => [job.state, job.error]),
    [['failed', 'Upload failed. Your text is saved; retry the attachment.']]
  )
  assert.deepEqual(takeIncomingMedia(draft), [])

  retryIncomingMedia(draft, id)
  // A second click while it runs cannot start it twice.
  retryIncomingMedia(draft, id)
  await settle()
  await settle()
  assert.equal(attempts, 2)
  assert.deepEqual(
    takeIncomingMedia(draft).map((item) => item.assetId),
    ['gif']
  )

  // A finished export can be dismissed from the list.
  dismissIncomingMedia(draft, id)
  assert.deepEqual(incomingMedia(draft), [])
})
