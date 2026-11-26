import assert from 'node:assert/strict'
import test from 'node:test'
import { streamLines } from '@/lib/api/stream-lines'

test('a failure before the first line rejects, so the route can answer with a status', async () => {
  await assert.rejects(
    streamLines(async () => {
      throw new Error('quota')
    }),
    /quota/
  )
})

test('a failure after the first line ends the stream with an error line and no detail', async (t) => {
  t.mock.method(console, 'error', () => {})
  const response = await streamLines(async (send) => {
    send({ text: 'Hel', type: 'text' })
    throw new Error('provider detail')
  })
  const lines = (await response.text()).trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[1]!).type, 'error')
  assert.ok(!lines[1]!.includes('provider detail'))
})
