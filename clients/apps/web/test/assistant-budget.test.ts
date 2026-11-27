import assert from 'node:assert/strict'
import test from 'node:test'
import {
  documentChatRequestSchema,
  MAX_ASSISTANT_MESSAGES_CHARS,
  MAX_DOCUMENT_MESSAGES_CHARS,
  workspaceAssistantRequestSchema,
} from '@/lib/api/contracts/ai'
import { userContent } from '@/lib/assistant/attachments'
import { measureMessageChars, trimMessagesToBudget } from '@/lib/assistant/snapshots'

test('trimMessagesToBudget drops oldest whole user turns while preserving newest turn and tool pairs', () => {
  const messages = [
    { content: 'a'.repeat(500), role: 'user' },
    { content: 'b'.repeat(500), role: 'assistant' },
    { content: 'c'.repeat(500), role: 'user' },
    { content: [{ toolCallId: 't1', type: 'tool-call' }], role: 'assistant' },
    { content: [{ output: 'd'.repeat(500), toolCallId: 't1', type: 'tool-result' }], role: 'tool' },
    { content: 'newest question', role: 'user' },
    { content: [{ toolCallId: 't2', type: 'tool-call' }], role: 'assistant' },
    { content: [{ output: 'recent result', toolCallId: 't2', type: 'tool-result' }], role: 'tool' },
  ]

  // Budget fits turn 2 (c + tool pair) and turn 3 (newest), drops turn 1 (a + b).
  const trimmed = trimMessagesToBudget(messages, 1_800)
  assert.equal(trimmed[0]?.role, 'user')
  assert.equal(trimmed[0]?.content, 'c'.repeat(500))
  assert.equal(trimmed.length, 6)

  // Tiny budget still preserves the entire newest user turn + its tool continuation intact.
  const minimal = trimMessagesToBudget(messages, 10)
  assert.equal(minimal.length, 3)
  assert.equal(minimal[0]?.content, 'newest question')
  assert.equal(minimal[2]?.role, 'tool')

  // Inline image attachment produced by userContent() is priced at a fixed ~2,000-char weight,
  // not its raw base64 size, so a 500k base64 image does not evict a small prior turn.
  const hugeBase64 = 'A'.repeat(500_000)
  const withImage = [
    { content: 'earlier context', role: 'user' },
    { content: 'earlier answer', role: 'assistant' },
    { content: userContent('check this screenshot', [hugeBase64]), role: 'user' },
  ]
  const kept = trimMessagesToBudget(withImage, 3_000)
  assert.equal(kept.length, 3)
  assert.ok(
    measureMessageChars(withImage[2], { allowInlineFileData: true, fileWeight: 2_000 }) < 2_500
  )
})

test('AI request contracts allow real inline file attachments and block raw data:image/ and sibling bypasses', () => {
  const basePage = {
    area: 'editor',
    entities: [],
    facts: [],
    path: '/editor',
    title: 'Editor',
  }

  const oversizedAssistant = workspaceAssistantRequestSchema.safeParse({
    messages: [{ content: 'x'.repeat(MAX_ASSISTANT_MESSAGES_CHARS + 1), role: 'user' }],
    page: basePage,
  })
  assert.equal(oversizedAssistant.success, false)

  // A valid >400k-char base64 image attachment built by userContent() must pass.
  const validAttachment = workspaceAssistantRequestSchema.safeParse({
    messages: [
      { content: userContent('Describe this capture', ['A'.repeat(500_000)]), role: 'user' },
    ],
    page: basePage,
  })
  assert.equal(validAttachment.success, true)

  // Raw text prefixed with `data:image/` must NOT bypass the text budget on either schema.
  const dataUriBypassAssistant = workspaceAssistantRequestSchema.safeParse({
    messages: [
      {
        content: `data:image/png;base64,${'A'.repeat(MAX_ASSISTANT_MESSAGES_CHARS)}`,
        role: 'user',
      },
    ],
    page: basePage,
  })
  assert.equal(dataUriBypassAssistant.success, false)

  // Extra loose sibling keys on a valid file part must still be counted against the text budget.
  const siblingSmuggle = workspaceAssistantRequestSchema.safeParse({
    messages: [
      {
        content: [
          {
            data: { data: 'AAAA', type: 'data' },
            extraText: 'z'.repeat(MAX_ASSISTANT_MESSAGES_CHARS + 1),
            mediaType: 'image/png',
            type: 'file',
          },
        ],
        role: 'user',
      },
    ],
    page: basePage,
  })
  assert.equal(siblingSmuggle.success, false)

  const okAssistant = workspaceAssistantRequestSchema.safeParse({
    messages: [{ content: 'hello', role: 'user' }],
    page: basePage,
  })
  assert.equal(okAssistant.success, true)

  const oversizedDoc = documentChatRequestSchema.safeParse({
    messages: [
      {
        parts: [{ text: 'y'.repeat(MAX_DOCUMENT_MESSAGES_CHARS + 1), type: 'text' }],
        role: 'user',
      },
    ],
  })
  assert.equal(oversizedDoc.success, false)

  const dataUriBypassDoc = documentChatRequestSchema.safeParse({
    messages: [
      {
        parts: [
          {
            text: `data:image/png;base64,${'B'.repeat(MAX_DOCUMENT_MESSAGES_CHARS)}`,
            type: 'text',
          },
        ],
        role: 'user',
      },
    ],
  })
  assert.equal(dataUriBypassDoc.success, false)
})
