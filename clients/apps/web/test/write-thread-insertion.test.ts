import assert from 'node:assert/strict'
import test from 'node:test'
import type { Value } from '@shots/platejs-editor/platejs'
import {
  createPlatePlugin,
  createPlateEditor,
  type PlateEditor,
} from '@shots/platejs-editor/platejs/react'
import { YjsPlugin } from '@shots/platejs-editor/collaboration'
import {
  appendPost,
  asUndoStep,
  deletePost,
  insertMention,
  insertPostBreak,
  insertSnippet,
  movePost,
  PostBreakPlugin,
  postRanges,
  setPostSettings,
  splitPostAtCaret,
} from '@/components/drafts/thread'
import { postBreak } from '@/lib/write/versions'
import { POST_BREAK, SOCIAL_MENTION } from '@/lib/content-drafts/serialize'

const p = (text = '') => ({ type: 'p', children: [{ text }] })

test('moving then deleting a post preserves the other post and its identity', () => {
  const first = postBreak()
  const second = postBreak()
  const editor = createPlateEditor({
    plugins: [PostBreakPlugin],
    value: [first, p('A'), second, p('B')] as Value,
  })
  movePost(editor, 2, 1)
  assert.equal(editor.children[0].id, second.id)
  assert.equal(editor.api.string([1]), 'B')
  assert.equal(editor.children[2].id, first.id)
  deletePost(editor, 2)
  assert.equal(editor.children[0].id, second.id)
  assert.equal(editor.api.string([1]), 'B')
  assert.equal(postRanges(editor.children).length, 1)
})

test('splitting at a word boundary removes the new post’s leading space', () => {
  const editor = createPlateEditor({
    plugins: [PostBreakPlugin],
    value: [postBreak(), p('First second')],
  })
  editor.tf.select({ path: [1, 0], offset: 5 })
  splitPostAtCaret(editor)
  assert.equal(editor.api.string([1]), 'First')
  assert.equal(editor.api.string([3]), 'second')
  assert.deepEqual(editor.selection?.anchor, { path: [3, 0], offset: 0 })
})

for (const selected of [null, [0, 0], [1, 0]]) {
  test(`add post keeps both headers and focuses the new paragraph from ${JSON.stringify(selected)}`, () => {
    const editor = createPlateEditor({ plugins: [PostBreakPlugin], value: [postBreak(), p()] })
    if (selected) editor.tf.select({ path: selected, offset: 0 })
    insertPostBreak(editor)
    assert.deepEqual(
      editor.children.map((node) => node.type),
      [POST_BREAK, 'p', POST_BREAK, 'p']
    )
    assert.deepEqual(editor.selection?.anchor, { path: [3, 0], offset: 0 })
  })
}

test('add post inserts after the whole current post, preserving its remaining paragraphs', () => {
  const editor = createPlateEditor({
    plugins: [PostBreakPlugin],
    value: [postBreak(), p('One'), p('Still one'), postBreak(), p('Two')],
  })
  editor.tf.select({ path: [1, 0], offset: 1 })
  insertPostBreak(editor)
  assert.deepEqual(postRanges(editor.children), [
    [0, 3],
    [3, 5],
    [5, 7],
  ])
  assert.equal(editor.api.string([2]), 'Still one')
  assert.equal(editor.api.string([6]), 'Two')
  assert.deepEqual(editor.selection?.anchor, { path: [4, 0], offset: 0 })
})

for (const selected of ['all', 'header'] as const) {
  test(`typing into ${selected} replaces text without leaving the selection in a header`, () => {
    const editor = createPlateEditor({
      plugins: [PostBreakPlugin],
      value: [postBreak(), p(selected === 'all' ? 'Old text' : '')],
    })
    editor.tf.select(selected === 'all' ? editor.api.range([]) : { path: [0, 0], offset: 0 })
    editor.tf.insertText('Replacement 🚀')
    assert.deepEqual(
      editor.children.map((node) => node.type),
      [POST_BREAK, 'p']
    )
    assert.equal(editor.api.string([1]), 'Replacement 🚀')
    assert.equal(editor.selection?.anchor.path[0], 1)
  })
}

/** The composer's mention node (social-mention.tsx), without its UI. */
const SocialMentionPlugin = createPlatePlugin({
  key: SOCIAL_MENTION,
  node: { isElement: true, isInline: true, isVoid: true },
})

/** A provider that never connects: the live session's history without a server. */
const offlineProvider = {
  awareness: null,
  connect() {},
  destroy() {},
  disconnect() {},
  document: null,
  isConnected: false,
  isConnectionPending: false,
  isSynced: true,
  isSyncPending: false,
  type: 'test',
}

/** An editor on Plate's own history, or on a live session's Yjs history, which merges edits within 500 ms. */
const histories: Record<string, (value: Value) => Promise<PlateEditor>> = {
  'Plate history': async (value) =>
    createPlateEditor({ plugins: [PostBreakPlugin, SocialMentionPlugin], value }),
  'live session history': async (value) => {
    const editor = createPlateEditor({
      plugins: [
        PostBreakPlugin,
        SocialMentionPlugin,
        YjsPlugin.configure({ options: { providers: [offlineProvider as never] } }),
      ],
      skipInitialization: true,
    })
    await editor.getApi(YjsPlugin).yjs.init({ autoConnect: false, id: 'undo-steps', value })
    return editor
  },
}

/** Let the editor's change handler run, as it does between keystrokes. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * The document without Plate's generated block ids: a live session's redo
 * rebuilds nodes from Yjs and Plate ids them anew. Post ids, on the breaks, stay.
 */
const content = (editor: PlateEditor): unknown =>
  JSON.parse(
    JSON.stringify(editor.children, function (key, value) {
      return key === 'id' && this.type !== POST_BREAK ? undefined : value
    })
  )

const actions: Record<string, (editor: PlateEditor) => void> = {
  split: (editor) => splitPostAtCaret(editor),
  mention: (editor) =>
    insertMention(editor, 'x', { handle: 'jane', kind: 'person', label: 'Jane', providerId: '42' }),
  poll: (editor) =>
    setPostSettings(editor, 1, { poll: { durationMinutes: 1_440, options: ['', ''] } }),
  'setting applied to every post': (editor) =>
    asUndoStep(editor, () => {
      setPostSettings(editor, 1, { replySettings: 'following' })
      setPostSettings(editor, 1, { disclosures: { madeWithAi: true } })
    }),
  snippet: (editor) => insertSnippet(editor, ' Follow for more.'),
  'closing-post template': (editor) => appendPost(editor, 'Thanks for reading.'),
}

for (const [history, create] of Object.entries(histories)) {
  for (const [name, act] of Object.entries(actions)) {
    test(`${history}: a ${name} undoes and redoes as one step and puts the caret back`, async () => {
      const editor = await create([postBreak(), p('Hello')])
      try {
        editor.tf.select({ path: [1, 0], offset: 5 })
        editor.tf.insertText(' world')
        await settle()
        // The caret goes back between the words, where the action happens.
        editor.tf.select({ path: [1, 0], offset: 5 })
        await settle()
        const before = content(editor)
        const caret = structuredClone(editor.selection)
        act(editor)
        await settle()
        const after = content(editor)
        assert.notDeepEqual(after, before)
        // Typing right after the action is a step of its own.
        editor.tf.insertText('!')
        await settle()
        editor.undo()
        assert.deepEqual(content(editor), after)
        editor.undo()
        assert.deepEqual(content(editor), before)
        assert.deepEqual(editor.selection, caret)
        editor.redo()
        assert.deepEqual(content(editor), after)
        editor.undo()
        assert.deepEqual(content(editor), before)
        assert.deepEqual(editor.selection, caret)
        // Typing right before the action stays a step of its own.
        editor.undo()
        assert.equal(editor.api.string([1]), 'Hello')
        assert.equal(editor.children.length, 2)
      } finally {
        if ('undoManager' in editor) {
          const { awareness, ydoc } = editor.getOptions(YjsPlugin)
          awareness.destroy()
          ydoc.destroy()
        }
      }
    })
  }
}
