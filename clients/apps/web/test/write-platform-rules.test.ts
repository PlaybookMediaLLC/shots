import assert from 'node:assert/strict'
import test from 'node:test'
import { mediaSwitches, platformRefusal } from '../lib/write/platform-rules'

const tiktok = { channel: 'tiktok', hasMedia: false, hasText: true, id: 'tiktok' } as const
const x = { channel: 'x', hasMedia: false, hasText: true, id: 'x' } as const
const none = new Set<string>()

test('a platform that needs media goes off when the post has words and none', () => {
  assert.deepEqual(mediaSwitches([tiktok, x], ['tiktok', 'x'], none, none), {
    off: ['tiktok'],
    on: [],
  })
})

test('an empty post changes nothing: the person may be about to attach', () => {
  const empty = { ...tiktok, hasText: false }
  assert.deepEqual(mediaSwitches([empty, x], ['tiktok', 'x'], none, none).off, [])
})

test('the only destination stays on, so the fix list can explain it', () => {
  assert.deepEqual(mediaSwitches([tiktok], ['tiktok'], none, none).off, [])
  const instagram = { ...tiktok, channel: 'instagram', id: 'instagram' } as const
  assert.deepEqual(mediaSwitches([tiktok, instagram], ['tiktok', 'instagram'], none, none).off, [])
})

test('a platform the person kept on is left alone', () => {
  assert.deepEqual(mediaSwitches([tiktok, x], ['tiktok', 'x'], none, new Set(['tiktok'])).off, [])
})

test('media brings back only what was switched off for lacking it', () => {
  const withVideo = { ...tiktok, hasMedia: true }
  assert.deepEqual(mediaSwitches([withVideo, x], ['x'], new Set(['tiktok']), none).on, ['tiktok'])
  assert.deepEqual(mediaSwitches([withVideo, x], ['x'], none, none).on, [])
})

test('a switch explains why it cannot change', () => {
  assert.match(String(platformRefusal('tiktok', 'article', false, 0)), /does not take/)
  assert.match(String(platformRefusal('x', 'reply', false, 1)), /one X account/)
  assert.equal(platformRefusal('x', 'reply', true, 1), null)
  assert.equal(platformRefusal('x', 'standard', false, 3), null)
})
