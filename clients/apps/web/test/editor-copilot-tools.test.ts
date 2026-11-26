import assert from 'node:assert/strict'
import test from 'node:test'
import { createEditorCopilotTools, editorClientToolNames } from '@/lib/ai/tools/editor-copilot'
import { asSchema } from 'ai'
import {
  describeToolActivity,
  recentMessages,
  runUnifiedAssistant,
} from '@/components/assistant/run-unified-assistant'
import { MAX_ASSISTANT_MESSAGES } from '@/lib/api/contracts/ai'

test('createEditorCopilotTools composes only the requested surface tools', () => {
  assert.deepEqual(Object.keys(createEditorCopilotTools([])), [])

  const editorSubset = createEditorCopilotTools([
    'inspectCanvas',
    'applyChanges',
    'reviewDesign',
    'applyBrandKit',
    'scanRedactions',
    'unknownToolIgnored',
  ])
  assert.deepEqual(Object.keys(editorSubset).sort(), [
    'applyBrandKit',
    'applyChanges',
    'inspectCanvas',
    'listDesignOptions',
    'reviewDesign',
    'scanRedactions',
  ])

  const storeSubset = createEditorCopilotTools([
    'inspectStoreSet',
    'dispatchStoreCommands',
    'generateStoreCopy',
    'translateStoreLocales',
  ])
  // Store surface has its own schema and does not need the screenshot-editor catalog tool.
  assert.deepEqual(Object.keys(storeSubset).sort(), [
    'dispatchStoreCommands',
    'generateStoreCopy',
    'inspectStoreSet',
    'translateStoreLocales',
  ])

  assert.ok(editorClientToolNames.includes('reviewDesign'))
  assert.ok(editorClientToolNames.includes('dispatchStoreCommands'))
})

test('describeToolActivity returns readable labels and recentMessages preserves user boundaries', () => {
  assert.equal(describeToolActivity('applyBrandKit'), 'Applying brand kit')
  assert.equal(describeToolActivity('reviewDesign'), 'Reviewing design')
  assert.equal(describeToolActivity('customTool'), 'customTool')

  const msgs = [
    { content: 'hi', role: 'user' },
    { content: 'tool', role: 'tool' },
    { content: 'second', role: 'user' },
    { content: 'reply', role: 'assistant' },
  ]
  assert.deepEqual(recentMessages(msgs, 3), msgs.slice(2))
})

test('the tweet tools refuse a padding the editor does not offer', async () => {
  const schema = asSchema(createEditorCopilotTools(['editTweet']).editTweet!.inputSchema)
  const check = (padding: number) =>
    schema.validate!({ commands: [{ padding, type: 'style' }], summary: 'x' })
  assert.equal((await check(64)).success, true)
  assert.equal((await check(65)).success, false)
})

test('dispatchStoreCommands gives the model typed commands without deletes', async () => {
  const schema = asSchema(
    createEditorCopilotTools(['dispatchStoreCommands']).dispatchStoreCommands!.inputSchema
  )
  const json = JSON.stringify(await schema.jsonSchema)
  assert.ok(json.includes('slides.setLayout'))
  assert.ok(!json.includes('slides.delete'))
  const check = (command: unknown) => schema.validate!({ commands: [command], summary: 'x' })
  assert.equal((await check({ slideIds: ['a'], type: 'slides.duplicate' })).success, true)
  assert.equal((await check({ slideIds: ['a'], type: 'slides.delete' })).success, false)
})

test('runUnifiedAssistant keeps every request within the message limit across round trips', async (t) => {
  const sizes: number[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    sizes.push((JSON.parse(String(init.body)) as { messages: unknown[] }).messages.length)
    const done = sizes.length > 1
    const reply = {
      done,
      links: [],
      messages: [{ content: 'ok', role: 'assistant' }],
      pendingToolCalls: done ? [] : [{ input: {}, toolCallId: '1', toolName: 'inspectCanvas' }],
      posts: [],
      text: '',
      toolSteps: [],
    }
    const lines = [
      { text: 'ok', type: 'text' },
      { reply, type: 'reply' },
    ]
    return new Response(lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
  })
  const history = Array.from({ length: MAX_ASSISTANT_MESSAGES - 2 }, (_, index) => ({
    content: 'x',
    role: index % 2 ? 'assistant' : 'user',
  }))
  await runUnifiedAssistant({
    ask: 'edit',
    executeClientTool: async () => ({ type: 'text', value: 'done' }),
    memory: { current: history },
    page: { area: 'editor', entities: [], facts: [], path: '/editor', title: 'Editor' },
    push: () => {},
    signal: new AbortController().signal,
  })
  assert.equal(sizes.length, 2)
  assert.ok(sizes.every((size) => size <= MAX_ASSISTANT_MESSAGES))
})
