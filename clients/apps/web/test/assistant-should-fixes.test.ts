import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import {
  pushAssistantEntry,
  syncAssistantOrganization,
  useAssistantStore,
} from '@/components/assistant/assistant-store'
import { runUnifiedAssistant } from '@/components/assistant/run-unified-assistant'
import { trimSnapshots } from '@/lib/assistant/snapshots'

const shot = (id: string) => ({
  output: { type: 'content', value: [{ data: id, type: 'file' }] },
  toolCallId: id,
  type: 'tool-result',
})

test('only the newest snapshot is kept, also when one message holds two results', () => {
  const kept = JSON.stringify(
    trimSnapshots([
      { content: [shot('old')], role: 'tool' },
      { content: [shot('first'), shot('newest')], role: 'tool' },
    ])
  )
  assert.ok(kept.includes('"data":"newest"'))
  assert.ok(!kept.includes('"data":"first"') && !kept.includes('"data":"old"'))
})

test('a tool that throws answers its call, so the conversation goes on', async (t) => {
  const bodies: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body))
    const done = bodies.length > 1
    const reply = {
      done,
      links: [],
      messages: [],
      pendingToolCalls: done ? [] : [{ input: {}, toolCallId: '1', toolName: 'inspectCanvas' }],
      posts: [],
      text: '',
      toolSteps: [],
    }
    return new Response(JSON.stringify({ reply, type: 'reply' }) + '\n')
  })
  await runUnifiedAssistant({
    ask: 'look',
    executeClientTool: async () => {
      throw new Error('no canvas')
    },
    memory: { current: [] },
    page: { area: 'editor', entities: [], facts: [], path: '/editor', title: 'Editor' },
    push: () => {},
    signal: new AbortController().signal,
  })
  assert.ok(bodies[1]!.includes('inspectCanvas failed: no canvas'))
})

test('switching workspace stops the run and starts an empty thread with new memory', () => {
  syncAssistantOrganization('org-a')
  const controller = new AbortController()
  useAssistantStore.setState({ controller })
  pushAssistantEntry({ kind: 'user', text: 'private to a' })
  const memory = useAssistantStore.getState().memory
  syncAssistantOrganization('org-b')
  const after = useAssistantStore.getState()
  assert.ok(controller.signal.aborted)
  assert.deepEqual(after.entries, [])
  // A late entry from the old run is dropped because the memory object changed.
  assert.notEqual(after.memory, memory)
})

/** Every file the assistant bar loads up front: static imports only, never `import()`. */
function staticImports(entry: string) {
  const root = process.cwd()
  const seen = new Set<string>()
  const find = (base: string) =>
    ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
      .map((suffix) => base + suffix)
      .find((file) => existsSync(file) && statSync(file).isFile())
  const walk = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(
      /^(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm
    )) {
      const name = match[1]!
      const base = name.startsWith('@/')
        ? join(root, name.slice(2))
        : name.startsWith('.')
          ? resolve(dirname(file), name)
          : null
      const next = base && find(base)
      if (next) walk(next)
    }
  }
  walk(join(root, entry))
  return [...seen].map((file) => file.slice(root.length + 1))
}

test('a platform page’s assistant loads no editor panel, canvas or export code', () => {
  const loaded = staticImports('components/assistant/AssistantBar.tsx')
  const editor = loaded.filter((file) =>
    /AssistantCards|VariantsPanel|CaptionsPanel|Redaction|ClientCanvas|lib\/design\/(apply|snapshot)|export-service|lib\/store\/index/.test(
      file
    )
  )
  assert.ok(loaded.length > 5)
  assert.deepEqual(editor, [])
})
