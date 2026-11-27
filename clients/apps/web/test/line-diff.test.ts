import assert from 'node:assert/strict'
import test from 'node:test'
import { lineDiff } from '@/lib/line-diff'

test('lineDiff computes minimal LCS diff with trimmed common head and tail', () => {
  const rows = lineDiff('a\nb\nc\nd', 'a\nb\nx\ny\nd')
  assert.deepEqual(rows, [
    { kind: 'same', before: 1, after: 1 },
    { kind: 'same', before: 2, after: 2 },
    { kind: 'del', before: 3 },
    { kind: 'add', after: 3 },
    { kind: 'add', after: 4 },
    { kind: 'same', before: 4, after: 5 },
  ])
})

test('lineDiff keeps identical text as unchanged rows', () => {
  const rows = lineDiff('one\ntwo', 'one\ntwo')
  assert.deepEqual(rows, [
    { kind: 'same', before: 1, after: 1 },
    { kind: 'same', before: 2, after: 2 },
  ])
})

test('lineDiff falls back to linear replace when changed middle exceeds LCS_LIMIT squared', () => {
  const before = ['head', ...Array.from({ length: 1_005 }, (_, i) => `old-${i}`), 'tail'].join('\n')
  const after = ['head', ...Array.from({ length: 1_005 }, (_, i) => `new-${i}`), 'tail'].join('\n')
  const rows = lineDiff(before, after)

  assert.deepEqual(rows[0], { kind: 'same', before: 1, after: 1 })
  assert.deepEqual(rows.at(-1), { kind: 'same', before: 1_007, after: 1_007 })
  assert.equal(rows.filter((row) => row.kind === 'del').length, 1_005)
  assert.equal(rows.filter((row) => row.kind === 'add').length, 1_005)
  // Removals precede additions in the replaced middle.
  assert.equal(rows[1]?.kind, 'del')
  assert.equal(rows[1_006]?.kind, 'add')
})
