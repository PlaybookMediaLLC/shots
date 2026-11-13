import assert from 'node:assert/strict'
import test from 'node:test'
import { serializeDraft } from '../lib/content-drafts/serialize'
import { xCollapsedText, previewLineLimit, previewScale } from '../lib/write/preview-layout'
import { xLength } from '../lib/content-drafts/x-length'
import { uploadByteLimit } from '../lib/write/media-limits'
import type { TElement } from '@shots/platejs-editor/platejs'
import { createPlateEditor } from '@shots/platejs-editor/platejs/react'
import {
  attachmentsIn,
  copyAttachment,
  ensureAttachmentIds,
  insertAttachments,
  moveAttachment,
  moveAttachmentRelative,
  removeAttachment,
  replaceWithDerived,
} from '../lib/write/media-operations'

const image = (id: string) => ({
  id,
  type: 'img',
  assetId: id,
  alt: `Description ${id}`,
  sourceAssetId: `original-${id}`,
  frameSettings: { color: '#112233' },
  children: [{ text: '' }],
})
const p = (text: string) => ({ type: 'p', children: [{ text }] })

test('TF-007 TF-092: move and copy retain identity, description, transform and publication order', () => {
  const editor = createPlateEditor({
    value: [
      p('First'),
      image('a'),
      image('b'),
      { id: 'post-2', type: 'post_break', children: [{ text: '' }] },
      p('Second'),
    ],
  })
  moveAttachment(editor, 'b', 1)
  assert.deepEqual(serializeDraft(editor.children, 'x').posts[0].assetIds, ['b', 'a'])
  editor.tf.undo()
  assert.deepEqual(serializeDraft(editor.children, 'x').posts[0].assetIds, ['a', 'b'])
  editor.tf.redo()
  assert.deepEqual(serializeDraft(editor.children, 'x').posts[0].assetIds, ['b', 'a'])
  copyAttachment(editor, 'a', editor.children.length)
  const copy = editor.children.at(-1)! as TElement
  assert.notEqual(copy.id, 'a')
  assert.deepEqual(copy.frameSettings, { color: '#112233' })
  assert.equal(copy.alt, 'Description a')
  const saved = JSON.parse(JSON.stringify(editor.children))
  const publication = serializeDraft(saved, 'x')
  assert.deepEqual(publication.posts[1].assetIds, ['a'])
  assert.equal(publication.posts[1].media[0].sourceAssetId, 'original-a')
})

test('removing an attachment leaves the rest, and undo brings it back', () => {
  const editor = createPlateEditor({ value: [p('First'), image('a'), image('b')] })
  removeAttachment(editor, { id: 'a', assetId: 'a' })
  assert.deepEqual(
    editor.children.flatMap((node) => attachmentsIn(node)).map((node) => node.assetId),
    ['b']
  )
  editor.tf.undo()
  assert.deepEqual(
    editor.children.flatMap((node) => attachmentsIn(node)).map((node) => node.assetId),
    ['a', 'b']
  )
})

test('seeded media with no node id is removed by its asset', () => {
  const seeded = { type: 'video', assetId: 'v', children: [{ text: '' }] }
  const editor = createPlateEditor({ value: [p('First'), seeded] })
  removeAttachment(editor, { assetId: 'v' })
  assert.deepEqual(
    editor.children.flatMap((node) => attachmentsIn(node)),
    []
  )
})

test('seeded media gets the id that moving it depends on', () => {
  const seeded = (assetId: string) => ({ type: 'img', assetId, children: [{ text: '' }] })
  const editor = createPlateEditor({ value: [p('First'), seeded('a'), seeded('b')] })
  ensureAttachmentIds(editor)
  const [a, b] = editor.children.flatMap((node) => attachmentsIn(node))
  assert.ok(a.id && b.id && a.id !== b.id)
  moveAttachmentRelative(editor, String(b.id), String(a.id))
  assert.deepEqual(
    editor.children.flatMap((node) => attachmentsIn(node)).map((node) => node.assetId),
    ['b', 'a']
  )
})

test('attaching keeps the caret in the caption and the picked order', () => {
  const editor = createPlateEditor({ value: [p('')] })
  editor.tf.select({ anchor: { path: [0, 0], offset: 0 }, focus: { path: [0, 0], offset: 0 } })
  insertAttachments(editor, [image('a'), image('b')])
  assert.deepEqual(editor.selection?.anchor.path, [0, 0])
  assert.deepEqual(
    editor.children.flatMap((node) => attachmentsIn(node)).map((node) => node.assetId),
    ['a', 'b']
  )
})

test('TF-076: unsupported combinations and excessive attachments fail without dropping media', () => {
  const mixed = serializeDraft(
    [p('Text'), image('a'), { ...image('gif'), mimeType: 'image/gif' }],
    'x'
  )
  assert.match(mixed.errors.join(' '), /on its own/)
  assert.equal(mixed.posts[0].media.length, 2)
  const excess = serializeDraft(
    [p('Text'), ...Array.from({ length: 21 }, (_, i) => image(String(i)))],
    'linkedin'
  )
  // LinkedIn's MultiImage API takes 2 to 20 images (read 2026-10-28).
  assert.match(excess.errors.join(' '), /up to 20/)
  assert.equal(excess.posts[0].assetIds.length, 21)
  assert.match(
    serializeDraft([p('Text'), { type: 'placeholder', children: [{ text: '' }] }], 'x').errors.join(
      ' '
    ),
    /Upload/
  )
  assert.match(
    serializeDraft(
      [{ ...image('a'), photoTags: [{ providerId: 'not-a-native-id' }] }],
      'x'
    ).errors.join(' '),
    /invalid photo-tag/
  )
})

test('TF-092: nested attachment moves retain discussion anchors and undo', () => {
  const original = { ...image('c'), children: [{ text: '', comment_thread: true }] }
  const editor = createPlateEditor({
    value: [{ type: 'column', children: [image('a'), image('b'), original] }, p('End')],
  })
  moveAttachmentRelative(editor, 'c', 'b')
  assert.deepEqual(serializeDraft(editor.children, 'x').posts[0].assetIds, ['a', 'c', 'b'])
  assert.deepEqual((editor.children[0].children[1] as TElement).children, original.children)
  editor.tf.undo()
  assert.deepEqual(serializeDraft(editor.children, 'x').posts[0].assetIds, ['a', 'b', 'c'])
})

test('TF-074 TF-085: weighted X cutoff preserves graphemes and complete links', () => {
  const family = '👨‍👩‍👧‍👦'
  const caption = `${'a'.repeat(240)} https://example.com/a-very-long-address ${family.repeat(25)}`
  const cut = xCollapsedText(caption)
  assert.ok(xLength(cut) <= 280)
  assert.ok(caption.startsWith(cut))
  assert.ok(cut.includes('https://example.com/a-very-long-address'))
  assert.ok(!cut.endsWith('\u200d'))
  assert.equal(xCollapsedText('A short post 🚀'), 'A short post 🚀')
  assert.equal(previewLineLimit('linkedin', 'one\ntwo\nthree\nfour'), 3)
  assert.equal(previewLineLimit('x', 'normal'), null)
  assert.equal(previewScale(300, 375), 0.8)
  assert.equal(previewScale(900, 375), 1)
})

test('TF-068: upload UI shares plan and media byte ceilings with Go', () => {
  assert.equal(uploadByteLimit('image/png', 'free'), 5_000_000)
  assert.equal(uploadByteLimit('image/png', 'pro'), 20_000_000)
  assert.equal(uploadByteLimit('application/pdf'), 100_000_000)
})

test('UP-03: a crop and a frame each replace the other on the attachment, and refuse a changed one', () => {
  const editor = createPlateEditor({ value: [image('a')] as never })
  const file = (assetId: string) => ({
    assetId,
    height: 600,
    mimeType: 'image/jpeg',
    sourceAssetId: 'original-a',
    url: `/api/v1/assets/${assetId}/content`,
    width: 480,
  })
  replaceWithDerived(editor, 'a', 'a', file('cropped'), {
    cropSettings: { ratio: 0.8, x: 0, y: 0.5 },
  })
  const [cropped] = editor.children as TElement[]
  assert.equal(cropped.assetId, 'cropped')
  assert.equal(cropped.sourceAssetId, 'original-a')
  assert.equal(cropped.processingStatus, 'ready')
  assert.deepEqual(cropped.cropSettings, { ratio: 0.8, x: 0, y: 0.5 })
  assert.equal(cropped.frameSettings, undefined, 'the crop replaced the frame')
  assert.equal(cropped.alt, 'Description a', 'the description stays')

  replaceWithDerived(editor, 'a', 'cropped', file('framed'), { frameSettings: { padding: 8 } })
  const [framed] = editor.children as TElement[]
  assert.deepEqual(framed.frameSettings, { padding: 8 })
  assert.equal(framed.cropSettings, undefined, 'the frame replaced the crop')

  assert.throws(
    () => replaceWithDerived(editor, 'a', 'cropped', file('late'), { frameSettings: {} }),
    /changed while it was being edited/
  )
  assert.equal((editor.children[0] as TElement).assetId, 'framed')
})
