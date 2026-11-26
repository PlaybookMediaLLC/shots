import assert from 'node:assert/strict'
import test from 'node:test'
import { queueChatWrite } from '@/components/assistant/assistant-store'

test('chat writes run in order, and a failed one does not stop the next', async () => {
  const done: string[] = []
  const save = queueChatWrite(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    done.push('save')
    throw new Error('offline')
  })
  const remove = queueChatWrite(async () => done.push('delete'))
  await assert.rejects(save, /offline/)
  await remove
  assert.deepEqual(done, ['save', 'delete'])
})
