import assert from 'node:assert/strict'
import test from 'node:test'
import { workspaceAssistantRequestSchema } from '@/lib/api/contracts/ai'
import { userContent } from '@/lib/assistant/attachments'

const page = { area: 'editor', entities: [], facts: [], path: '/editor', title: 'Editor' }
const accepts = (content: unknown, role = 'user') =>
  workspaceAssistantRequestSchema.safeParse({ messages: [{ content, role }], page }).success

test('inline images pass, and no message can make the server fetch an address', () => {
  assert.ok(accepts(userContent('look', ['aGVsbG8='])))
  const url = 'https://169.254.169.254/latest'
  for (const part of [
    { data: { type: 'url', url }, mediaType: 'image/png', type: 'file' },
    { data: url, mediaType: 'image/png', type: 'file' },
    { image: url, type: 'image' },
  ])
    assert.equal(accepts([part]), false)
  // A key on the message itself must not switch the check off.
  assert.equal(
    workspaceAssistantRequestSchema.safeParse({
      messages: [{ content: [{ image: url, type: 'image' }], role: 'user', type: 'tool-call' }],
      page,
    }).success,
    false
  )
  assert.equal(accepts([{ data: url, type: 'reasoning-file' }], 'assistant'), false)
  const hidden = {
    output: { type: 'content', value: [{ type: 'file-url', url }] },
    toolCallId: '1',
    toolName: 'x',
    type: 'tool-result',
  }
  assert.equal(accepts([hidden], 'tool'), false)
})
