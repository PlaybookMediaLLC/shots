import assert from 'node:assert/strict'
import test from 'node:test'
import { quotedRange } from '@/lib/write/quoted-range'

const body = [
  { children: [{ text: '' }], type: 'post_break' },
  {
    children: [{ text: 'We shipped ' }, { bold: true, text: 'faster' }, { text: ' exports.' }],
    type: 'p',
  },
]

test('a quoted passage is found across formatted leaves', () => {
  assert.deepEqual(quotedRange(body, 'shipped faster'), {
    anchor: { offset: 3, path: [1, 0] },
    focus: { offset: 6, path: [1, 1] },
  })
})

test('a quote that starts at a leaf boundary starts in that leaf', () => {
  assert.deepEqual(quotedRange(body, 'faster')?.anchor, { offset: 0, path: [1, 1] })
})

test('text the post does not hold, or nothing, anchors nowhere', () => {
  assert.equal(quotedRange(body, 'slower'), null)
  assert.equal(quotedRange(body, '   '), null)
})
