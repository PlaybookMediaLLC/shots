import assert from 'node:assert/strict'
import test from 'node:test'
import { serializeMd } from '@shots/platejs-editor/@platejs/markdown'
import { MentionPlugin } from '@shots/platejs-editor/@platejs/mention/react'
import { createMarkdownKit } from '@shots/platejs-editor/markdown-kit'
import { createPlateEditor, createPlatePlugin } from '@shots/platejs-editor/platejs/react'
import type { TDiscussion } from '@shots/platejs-editor/plugins'
import { attachEditorAIComment } from '@/components/write/composer/ai-review'
import { SOCIAL_MENTION } from '@/lib/content-drafts/serialize'
import { socialMentionMarkdownRules } from '@/lib/editor/services'
import { quotedRange, stripQuoteMarkdown } from '@/lib/write/quoted-range'

const testSocialMentionPlugin = createPlatePlugin({
  key: SOCIAL_MENTION,
  node: { isElement: true, isInline: true, isVoid: true },
})

const testDiscussionPlugin = createPlatePlugin({
  key: 'discussion',
  options: {
    currentUserId: 'user_1',
    discussions: [] as TDiscussion[],
  },
})

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

test('quotes with Markdown syntax and escapes match plain leaves linearly', () => {
  const formatted = [
    {
      children: [
        { text: 'Check ' },
        { bold: true, text: 'faster' },
        { text: ' exports via ' },
        { code: true, text: 'shots_cli' },
        { text: ' on our ' },
        { children: [{ text: 'release page' }], type: 'a', url: 'https://example.com/releases' },
        { text: ' *important* now*.' },
      ],
      type: 'p',
    },
  ]

  assert.deepEqual(quotedRange(formatted, 'Check **faster** exports'), {
    anchor: { offset: 0, path: [0, 0] },
    focus: { offset: 8, path: [0, 2] },
  })
  assert.deepEqual(
    quotedRange(
      formatted,
      'via `shots_cli` on our [release page](https://example.com/releases) \\*important\\* now\\*.'
    ),
    {
      anchor: { offset: 9, path: [0, 2] },
      focus: { offset: 18, path: [0, 6] },
    }
  )
  assert.equal(
    stripQuoteMarkdown('**bold** and _italic_ with foo_bar_baz and \\*literal\\*'),
    'bold and italic with foo_bar_baz and *literal*'
  )

  // Unclosed Markdown link must finish in linear time (ReDoS regression).
  const started = performance.now()
  const adversarial = `[label](${'x'.repeat(80)} unclosed`
  assert.equal(stripQuoteMarkdown(adversarial), adversarial)
  assert.ok(performance.now() - started < 50)
})

test('quotes containing mention and social_mention nodes attach cleanly', () => {
  const withMentions = [
    {
      children: [
        { text: 'Ask ' },
        { children: [{ text: '' }], type: 'mention', value: 'alice' },
        { text: ' about ' },
        {
          children: [{ text: '' }],
          handle: 'playbook',
          label: 'Playbook Media',
          platform: 'x',
          providerId: '123',
          type: 'social_mention',
        },
        { text: ' today.' },
      ],
      type: 'p',
    },
  ]

  assert.deepEqual(quotedRange(withMentions, 'Ask @alice about'), {
    anchor: { offset: 0, path: [0, 0] },
    focus: { offset: 6, path: [0, 2] },
  })
  assert.deepEqual(quotedRange(withMentions, 'Ask [alice](mention:alice) about'), {
    anchor: { offset: 0, path: [0, 0] },
    focus: { offset: 6, path: [0, 2] },
  })
  assert.deepEqual(quotedRange(withMentions, 'about @Playbook Media today.'), {
    anchor: { offset: 1, path: [0, 2] },
    focus: { offset: 7, path: [0, 4] },
  })
  assert.deepEqual(quotedRange(withMentions, 'about @playbook today.'), {
    anchor: { offset: 1, path: [0, 2] },
    focus: { offset: 7, path: [0, 4] },
  })
  // Mention-boundary quotes (starting or ending directly on a mention, and leading empty text leaf).
  assert.deepEqual(quotedRange(withMentions, '@alice about'), {
    anchor: { offset: 4, path: [0, 0] },
    focus: { offset: 6, path: [0, 2] },
  })
  assert.deepEqual(quotedRange(withMentions, 'Ask @alice'), {
    anchor: { offset: 0, path: [0, 0] },
    focus: { offset: 0, path: [0, 2] },
  })
  const leadingMention = [
    {
      children: [
        { text: '' },
        { children: [{ text: '' }], type: 'mention', value: 'alice' },
        { text: ' shipped it.' },
      ],
      type: 'p',
    },
  ]
  assert.deepEqual(quotedRange(leadingMention, '@alice shipped'), {
    anchor: { offset: 0, path: [0, 0] },
    focus: { offset: 8, path: [0, 2] },
  })

  // A malformed childless mention node is skipped safely instead of fabricating a bad path.
  const childless = [{ children: [{ type: 'mention', value: 'ghost' }], type: 'p' }]
  assert.equal(quotedRange(childless, '@ghost'), null)
})

test('reviewing a selection matches the selected copy before an earlier duplicate', () => {
  const repeated = [
    {
      children: [{ text: 'We shipped faster exports yesterday and faster exports today.' }],
      type: 'p',
    },
    { children: [{ text: 'We shipped faster exports today.' }], type: 'p' },
  ]
  // Same-paragraph second occurrence (non-zero preferredRange start offset).
  const sameParagraphSecond = {
    anchor: { offset: 36, path: [0, 0] },
    focus: { offset: 61, path: [0, 0] },
  }
  assert.deepEqual(quotedRange(repeated, 'faster exports', sameParagraphSecond), {
    anchor: { offset: 40, path: [0, 0] },
    focus: { offset: 54, path: [0, 0] },
  })

  const secondLineSelection = {
    anchor: { offset: 0, path: [1, 0] },
    focus: { offset: 32, path: [1, 0] },
  }
  const backwardSelection = {
    anchor: { offset: 32, path: [1, 0] },
    focus: { offset: 0, path: [1, 0] },
  }

  assert.deepEqual(quotedRange(repeated, 'faster exports', secondLineSelection), {
    anchor: { offset: 11, path: [1, 0] },
    focus: { offset: 25, path: [1, 0] },
  })
  assert.deepEqual(quotedRange(repeated, '**faster** exports', backwardSelection), {
    anchor: { offset: 11, path: [1, 0] },
    focus: { offset: 25, path: [1, 0] },
  })
  // Falls back to the full document when the quote is outside the selection.
  assert.deepEqual(quotedRange(repeated, 'yesterday', secondLineSelection), {
    anchor: { offset: 26, path: [0, 0] },
    focus: { offset: 35, path: [0, 0] },
  })
})

test('attachEditorAIComment preserves mid-leaf documentContent, coexisting overlapping marks, and stale selection safety', () => {
  const editor = createPlateEditor({
    plugins: [MentionPlugin, testSocialMentionPlugin, testDiscussionPlugin],
    value: [
      {
        children: [
          { text: 'Ask ' },
          { children: [{ text: '' }], type: 'mention', value: 'alice' },
          { text: ' about ' },
          { bold: true, text: 'faster' },
          { text: ' exports today.' },
        ],
        type: 'p',
      },
      {
        children: [{ text: 'We shipped faster exports today.' }],
        type: 'p',
      },
    ],
  })
  editor.setOption(testDiscussionPlugin, 'currentUserId', 'user_1')
  editor.setOption(testDiscussionPlugin, 'discussions', [])

  const notices: string[] = []
  let attachedEvents = 0

  // 1. Mid-leaf multi-leaf quote starting at offset > 0 preserves exact documentContent despite split:true.
  assert.equal(
    attachEditorAIComment(
      editor,
      {
        comment: 'Be specific about the speedup.',
        content: 'sk @alice about **faster** exports',
        editorId: String(editor.id),
        markAttached: () => {
          attachedEvents += 1
        },
      },
      true,
      (message) => notices.push(message)
    ),
    true
  )
  assert.equal(attachedEvents, 1)
  const firstDiscussion = editor.getOption(testDiscussionPlugin, 'discussions')[0]
  assert.equal(firstDiscussion.documentContent, 'sk  about faster exports')
  assert.equal(notices.length, 0)

  const firstMarkKey = `comment_${firstDiscussion.id}`
  assert.equal(
    editor.api.some({
      at: [],
      match: (node) =>
        'text' in node &&
        Boolean((node as Record<string, unknown>).comment) &&
        Boolean((node as Record<string, unknown>)[firstMarkKey]),
    }),
    true
  )

  // 2. Overlapping second comment on 'faster' coexists with the first comment's mark and comment:true.
  assert.equal(
    attachEditorAIComment(
      editor,
      {
        comment: 'Quantify faster.',
        content: 'faster',
        editorId: String(editor.id),
        markAttached: () => {
          attachedEvents += 1
        },
      },
      true,
      (message) => notices.push(message)
    ),
    true
  )
  assert.equal(attachedEvents, 2)
  const overlapDiscussion = editor.getOption(testDiscussionPlugin, 'discussions')[1]
  const overlapMarkKey = `comment_${overlapDiscussion.id}`
  assert.equal(
    editor.api.some({
      at: [0],
      match: (node) =>
        'text' in node &&
        node.text === 'faster' &&
        Boolean((node as Record<string, unknown>).comment) &&
        Boolean((node as Record<string, unknown>)[firstMarkKey]) &&
        Boolean((node as Record<string, unknown>)[overlapMarkKey]),
    }),
    true
  )

  // 3. Mention-only void quote fails cleanly without mutating undo/marks or clobbering comment:true.
  const snapshotBeforeVoid = JSON.stringify(editor.children)
  assert.equal(
    attachEditorAIComment(
      editor,
      {
        comment: 'Tag the team account instead.',
        content: '@alice',
        editorId: String(editor.id),
        markAttached: () => {
          attachedEvents += 1
        },
      },
      true,
      (message) => notices.push(message)
    ),
    false
  )
  assert.equal(JSON.stringify(editor.children), snapshotBeforeVoid)
  assert.equal(attachedEvents, 2)
  assert.equal(editor.getOption(testDiscussionPlugin, 'discussions').length, 2)
  assert.equal(notices.at(-1), 'AI review: Tag the team account instead.')

  // 4. Stale/out-of-bounds detail.selection without content falls back cleanly instead of throwing.
  assert.equal(
    attachEditorAIComment(
      editor,
      {
        comment: 'Stale selection note.',
        editorId: String(editor.id),
        selection: {
          anchor: { offset: 0, path: [99, 0] },
          focus: { offset: 10, path: [99, 0] },
        },
      },
      true,
      (message) => notices.push(message)
    ),
    false
  )
  assert.equal(notices.at(-1), 'AI review: Stale selection note.')

  // 5. detail.selection disambiguates duplicate phrase onto paragraph 2, and unmatched quote falls back.
  assert.equal(
    attachEditorAIComment(
      editor,
      {
        comment: 'Trim the second paragraph.',
        content: 'faster exports',
        editorId: String(editor.id),
        markAttached: () => {
          attachedEvents += 1
        },
        selection: {
          anchor: { offset: 0, path: [1, 0] },
          focus: { offset: 32, path: [1, 0] },
        },
      },
      true,
      (message) => notices.push(message)
    ),
    true
  )
  assert.equal(attachedEvents, 3)
  const secondDiscussion = editor.getOption(testDiscussionPlugin, 'discussions')[2]
  assert.equal(secondDiscussion.documentContent, 'faster exports')
  assert.equal(
    editor.api.some({
      at: [1],
      match: (node) =>
        'text' in node &&
        Boolean((node as Record<string, unknown>)[`comment_${secondDiscussion.id}`]),
    }),
    true
  )

  assert.equal(
    attachEditorAIComment(
      editor,
      {
        comment: 'Missing text notice.',
        content: 'does not exist',
        editorId: String(editor.id),
      },
      true,
      (message) => notices.push(message)
    ),
    false
  )
  assert.equal(notices.at(-1), 'AI review: Missing text notice.')

  // 6. Disabling comments (platform version tab) never adds a transient thread.
  assert.equal(
    attachEditorAIComment(
      editor,
      {
        comment: 'Tighten this.',
        content: 'today.',
        editorId: String(editor.id),
        markAttached: () => {
          attachedEvents += 1
        },
      },
      false,
      (message) => notices.push(message)
    ),
    false
  )
  assert.equal(attachedEvents, 3)
  assert.equal(editor.getOption(testDiscussionPlugin, 'discussions').length, 3)
  assert.equal(notices.at(-1), 'AI review: Tighten this.')
})

test('socialMentionMarkdownRules serializes social mentions with @-only/whitespace fallback while keeping GFM tables intact', () => {
  const editor = createPlateEditor({
    plugins: [testSocialMentionPlugin, ...createMarkdownKit(socialMentionMarkdownRules())],
    value: [
      {
        children: [
          { text: 'Built with ' },
          {
            children: [{ text: '' }],
            handle: 'playbook',
            label: '@@Playbook Media',
            type: 'social_mention',
          },
          { text: ' and ' },
          {
            children: [{ text: '' }],
            handle: '@shots_app',
            label: '@@@',
            type: 'social_mention',
          },
          { text: '.' },
        ],
        type: 'p',
      },
      {
        children: [
          {
            children: [
              { children: [{ children: [{ text: 'Metric' }], type: 'p' }], type: 'th' },
              { children: [{ children: [{ text: 'Before' }], type: 'p' }], type: 'th' },
            ],
            type: 'tr',
          },
          {
            children: [
              { children: [{ children: [{ text: 'Export' }], type: 'p' }], type: 'td' },
              { children: [{ children: [{ text: '2s' }], type: 'p' }], type: 'td' },
            ],
            type: 'tr',
          },
        ],
        type: 'table',
      },
    ],
  })

  const md = serializeMd(editor)
  assert.ok(md.includes('@Playbook Media'), `expected @Playbook Media in ${md}`)
  assert.ok(md.includes('@shots_app'), `expected @shots_app in ${md}`)
  assert.ok(md.includes('| Metric | Before |'), `expected GFM table in ${md}`)
})
