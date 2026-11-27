import assert from 'node:assert/strict'
import test from 'node:test'
import { resumedMemory, savedEntries } from '@/lib/assistant/saved-thread'

test('a long thread keeps only the newest entries that the backend accepts', () => {
  const kept = savedEntries(
    Array.from({ length: 100 }, (_, n) => ({
      kind: 'assistant',
      text: `${n} ${'é'.repeat(4_000)}`,
    }))
  )
  assert.ok(kept.length > 0 && kept.length < 100)
  assert.ok(new TextEncoder().encode(JSON.stringify(kept)).length <= 200_000)
  assert.ok(JSON.stringify(kept.at(-1)).includes('99 '))
})

test('a saved thread keeps words and in-app links, and drops cards and outside links', () => {
  const kept = savedEntries([
    { id: 1, kind: 'user', text: 'hi' },
    { id: 2, kind: 'variants', count: 4, instruction: '' },
    { id: 3, kind: 'change', text: 'Applied', undo: () => true },
    { href: '/library', kind: 'link', text: 'Library' },
    { href: 'https://evil.test', kind: 'link', text: 'x' },
    { href: 'javascript:alert(1)', kind: 'link', text: 'x' },
    { kind: 'assistant', text: 'hello' },
  ])
  assert.deepEqual(
    kept.map((entry) => entry.kind),
    ['user', 'change', 'link', 'assistant']
  )
  assert.ok(!('undo' in kept[1]!))
  assert.deepEqual(resumedMemory(kept), [
    { content: 'hi', role: 'user' },
    { content: '[Applied earlier change: Applied]', role: 'assistant' },
    { content: 'hello', role: 'assistant' },
  ])
})
