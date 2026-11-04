import assert from 'node:assert/strict'
import test from 'node:test'
import type { Value } from '@shots/platejs-editor/platejs'
import { createPlateEditor } from '@shots/platejs-editor/platejs/react'
import { overflowRanges, overflowStart } from '@/components/drafts/over-limit'
import { duplicatePost, PostBreakPlugin, postRanges } from '@/components/drafts/thread'
import {
  type CommandContext,
  commandsFor,
  rankCommands,
} from '@/components/write/composer/commands'
import type { RefineApi } from '@/components/write/composer/refine'
import { convertLegacyBlocks, legacyCount, withoutLegacy } from '@/lib/write/legacy-blocks'
import { normalizeMentions } from '@/lib/write/normalize-mentions'
import { postBreak } from '@/lib/write/versions'

const p = (text = '') => ({ type: 'p', children: [{ text }] })

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  const ai: RefineApi = { busy: false, open: () => undefined, run: () => undefined }
  return {
    addMedia: () => undefined,
    ai,
    channel: 'x',
    channels: ['x', 'tiktok'],
    editor: createPlateEditor({
      plugins: [PostBreakPlugin],
      value: [postBreak(), p('Hi')] as Value,
    }),
    giphy: false,
    openTool: () => undefined,
    postSetting: () => undefined,
    snippets: [],
    ...overrides,
  }
}

const ids = (commands: { id: string }[]) => commands.map((command) => command.id)

test('the slash menu offers about twenty publishable commands, no document blocks', () => {
  const commands = commandsFor(context())
  assert.ok(commands.length >= 18 && commands.length <= 24, `${commands.length} commands`)
  const labels = commands.map((command) => command.label).join(' | ')
  for (const gone of ['Heading', 'Toggle', 'Callout', 'Code', 'columns', 'Turn into', 'color'])
    assert.ok(!labels.includes(gone), `${gone} is not offered`)
})

test('poll is offered on X and hidden on TikTok; GIF only when search is approved', () => {
  assert.ok(ids(commandsFor(context())).includes('insert-poll'))
  assert.equal(
    commandsFor(context()).find((command) => command.id === 'insert-poll')?.badge,
    'X only'
  )
  assert.ok(!ids(commandsFor(context({ channel: 'tiktok' }))).includes('insert-poll'))
  assert.ok(!ids(commandsFor(context())).includes('insert-gif'))
  assert.ok(ids(commandsFor(context({ giphy: true }))).includes('insert-gif'))
})

test('AI commands follow the platforms and disappear when AI is off', () => {
  const commands = commandsFor(context())
  assert.ok(ids(commands).includes('ai-rewrite-tiktok'))
  assert.ok(!ids(commands).includes('ai-rewrite-x'))
  assert.equal(commands.find((command) => command.id === 'ai-shorten')?.label, 'Shorten to fit X')
  assert.ok(!ids(commandsFor(context({ ai: null }))).some((id) => id.startsWith('ai-')))
})

test('tables and math say they publish as images; snippets come from finishers', () => {
  const commands = commandsFor(
    context({ snippets: [{ id: 'f1', name: 'Signature', text: 'Thanks for reading' }] })
  )
  assert.equal(
    commands.find((command) => command.id === 'insert-table')?.badge,
    'Publishes as image'
  )
  assert.equal(
    commands.find((command) => command.id === 'insert-math')?.badge,
    'Publishes as image'
  )
  assert.equal(commands.find((command) => command.id === 'snippet-f1')?.label, 'Signature')
})

test('ranking respects the query, pins nothing, and matches aliases', () => {
  const commands = commandsFor(context())
  const he = rankCommands(commands, 'he')
  assert.ok(he.length > 0)
  assert.notEqual(he[0].id, 'ai-ask', 'Ask AI is not pinned above matches')
  assert.deepEqual(rankCommands(commands, 'zzz'), [])
  assert.equal(rankCommands(commands, 'img')[0].id, 'insert-media')
  assert.equal(rankCommands(commands, 'split')[0].group, 'Post')
})

test('recent commands come first when nothing is typed', () => {
  const commands = commandsFor(context())
  const ranked = rankCommands(commands, '', ['insert-table', 'missing', 'post-split'])
  assert.deepEqual(ids(ranked.slice(0, 2)), ['insert-table', 'post-split'])
  assert.equal(ranked.length, commands.length)
})

test('duplicating a post copies its text below it as a new post, in one step', () => {
  const first = postBreak()
  const editor = createPlateEditor({
    plugins: [PostBreakPlugin],
    value: [first, p('One'), postBreak(), p('Two')] as Value,
  })
  duplicatePost(editor, 1)
  assert.equal(postRanges(editor.children).length, 3)
  assert.equal(editor.api.string([3]), 'One')
  assert.notEqual(editor.children[2].id, first.id)
  editor.undo()
  assert.equal(postRanges(editor.children).length, 2)
})

test('half-typed inputs never persist: a slash command is dropped, emoji keep their text', () => {
  const body = [
    {
      type: 'p',
      children: [
        { text: 'Hi ' },
        { type: 'slash_input', trigger: '/', children: [{ text: '' }] },
        { type: 'emoji_input', trigger: ':', value: 'fir', children: [{ text: '' }] },
      ],
    },
  ]
  assert.deepEqual(normalizeMentions(body)[0].children, [
    { text: 'Hi ' },
    { text: '' },
    { text: ':fir' },
  ])
})

test('the characters past a post’s limit are marked from its end, and a split starts at that word', () => {
  const body = [postBreak(), p('Short'), postBreak(), p('One two three'), p('four five')] as Value
  // Post 2 is six characters over: "r five"; the split moves the whole word "four" on.
  const ranges = overflowRanges(body, { 2: 6 }, 'tiktok')
  assert.deepEqual([...ranges.entries()], [['4.0', [3, 9]]])
  assert.deepEqual(overflowStart(body, 2, { 2: 6 }, 'tiktok'), { offset: 0, path: [4, 0] })
  // X weighs a CJK character as two, so one character covers an excess of two.
  assert.deepEqual(
    [...overflowRanges([postBreak(), p('ab漢')] as Value, { 1: 2 }, 'x')],
    [['1.0', [2, 3]]]
  )
  assert.equal(overflowRanges(body, {}, 'x').size, 0)
})

test('an old draft’s document formatting converts to the plain text it publishes, in one step', () => {
  const value = [
    postBreak(),
    { type: 'h2', children: [{ text: 'Title' }] },
    { type: 'callout', children: [p('Note'), p('More')] },
    { type: 'toc', children: [{ text: '' }] },
    { type: 'column_group', children: [{ type: 'column', children: [p('Left')] }] },
    {
      type: 'p',
      children: [
        { text: 'Red', color: '#f00' },
        { text: ' plain', bold: true },
      ],
    },
  ] as Value
  const editor = createPlateEditor({ plugins: [PostBreakPlugin], value })
  assert.equal(legacyCount(editor.children), 6)
  convertLegacyBlocks(editor)
  assert.equal(legacyCount(editor.children), 0)
  assert.deepEqual(
    editor.children
      .slice(1)
      .map((node) => [node.type, editor.api.string(editor.api.findPath(node)!)]),
    [
      ['p', 'Title'],
      ['p', 'Note'],
      ['p', 'More'],
      ['p', 'Left'],
      ['p', 'Red plain'],
    ]
  )
  assert.equal((editor.children[5].children as { bold?: boolean }[])[1].bold, true)
  editor.undo()
  assert.equal(legacyCount(editor.children), 6)
})

test('a paste keeps bold, italic, links and lists and loses headings, colors and callouts', () => {
  const pasted = [
    { type: 'h1', children: [{ text: 'Title', color: 'red' }] },
    {
      type: 'p',
      children: [
        { text: 'Bold', bold: true, fontFamily: 'Georgia' },
        { type: 'a', url: 'https://example.com', children: [{ text: 'link' }] },
      ],
    },
    { type: 'callout', children: [p('Inside')] },
    { type: 'p', indent: 1, listStyleType: 'disc', children: [{ text: 'Item', italic: true }] },
    { type: 'toc', children: [{ text: '' }] },
  ]
  assert.deepEqual(withoutLegacy(pasted), [
    { type: 'p', children: [{ text: 'Title' }] },
    {
      type: 'p',
      children: [
        { text: 'Bold', bold: true },
        { type: 'a', url: 'https://example.com', children: [{ text: 'link' }] },
      ],
    },
    p('Inside'),
    { type: 'p', indent: 1, listStyleType: 'disc', children: [{ text: 'Item', italic: true }] },
  ])
})
