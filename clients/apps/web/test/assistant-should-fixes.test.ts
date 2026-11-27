import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import {
  loadStoredAssistantMode,
  pushAssistantEntry,
  resumeAssistantThread,
  setAssistantModelOverride,
  startAssistantOver,
  syncAssistantOrganization,
  toggleAssistantContextRef,
  useAssistantStore,
} from '@/components/assistant/assistant-store'
import { runUnifiedAssistant } from '@/components/assistant/run-unified-assistant'
import { MODEL_PRICES } from '@/lib/ai/metering/pricing'
import {
  AI_MODEL_TIER_LIST,
  parseWorkspaceAiDefaults,
  resolveEffectivePreference,
  surfaceToAiSlot,
} from '@/lib/ai/models/tiers'
import { INTERNAL_HREF_MAX, safeLinkHref } from '@/lib/assistant/page-context'
import { resumedMemory, savedEntries } from '@/lib/assistant/saved-thread'
import { trimSnapshots } from '@/lib/assistant/snapshots'
import { encodePcmWav } from '@/lib/assistant/wav-encoder'
import { validateVoiceMemo } from '@/lib/write/voice-memo'
import { workspaceAiSettingsUpdateSchema } from '@/lib/workspace/schemas'

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

test('encodePcmWav produces 16kHz RIFF/WAVE bytes accepted by validateVoiceMemo', () => {
  const samples = new Float32Array(48_000)
  for (let i = 0; i < samples.length; i += 1)
    samples[i] = Math.sin((i / 48_000) * Math.PI * 2 * 440)
  const wav = encodePcmWav(samples, 48_000)
  // 1 second at 48 kHz downsampled to 16 kHz mono 16-bit PCM = 44 header + 32,000 bytes
  assert.equal(wav.byteLength, 44 + 16_000 * 2)
  assert.doesNotThrow(() => validateVoiceMemo(wav, 'audio/wav'))
})

test('savedEntries keeps long internal startWork hrefs and resumedMemory retains changes/posts', () => {
  const longHref = `/editor?start=new&ask=${'a'.repeat(1_500)}`
  assert.ok(longHref.length < INTERNAL_HREF_MAX)
  const kept = savedEntries([
    { kind: 'user', text: 'Make it bolder' },
    { kind: 'change', text: 'Increased headline contrast' },
    { kind: 'post', text: 'We just shipped unified AI.' },
    { href: longHref, kind: 'link', text: 'Start this visual' },
  ])
  assert.equal(kept.length, 4)
  assert.equal(kept[3]?.kind === 'link' ? kept[3].href : '', longHref)
  const mem = resumedMemory(kept)
  assert.equal(mem.length, 3)
  assert.match(mem[1]!.content, /Increased headline contrast/)
  assert.match(mem[2]!.content, /We just shipped unified AI/)
})

test('aborting a mid-turn run restores prior clean memory instead of wiping the whole thread', async (t) => {
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', async () => {
    controller.abort()
    throw new DOMException('Aborted', 'AbortError')
  })
  const prior = [
    { content: 'First question', role: 'user' },
    { content: 'First answer', role: 'assistant' },
  ]
  const memory: { current: unknown[] } = { current: [...prior] }
  await assert.rejects(() =>
    runUnifiedAssistant({
      ask: 'Second question',
      memory,
      page: { area: 'home', entities: [], facts: [], path: '/home', title: 'Home' },
      push: () => {},
      signal: controller.signal,
    })
  )
  assert.deepEqual(memory.current, prior)
})

test('resolveEffectivePreference honors surface override, workspace default, then system default', () => {
  assert.deepEqual(resolveEffectivePreference(undefined, 'editors'), {
    effort: 'medium',
    inheritedFrom: 'system',
    tier: 'fast',
  })
  assert.deepEqual(
    resolveEffectivePreference({ default: { effort: 'high', tier: 'balanced' } }, 'editors'),
    {
      effort: 'high',
      inheritedFrom: 'workspace',
      tier: 'balanced',
    }
  )
  assert.deepEqual(
    resolveEffectivePreference(
      {
        default: { effort: 'medium', tier: 'fast' },
        editors: { effort: 'low', tier: 'deep' },
      },
      'editors'
    ),
    {
      effort: 'low',
      inheritedFrom: 'surface',
      tier: 'deep',
    }
  )
  assert.equal(surfaceToAiSlot(undefined), 'assistant')
  assert.equal(surfaceToAiSlot('write-composer'), 'writing')
  assert.equal(surfaceToAiSlot('campaign'), 'campaigns')
  assert.equal(surfaceToAiSlot('screenshot-editor'), 'editors')
})

test('switching workspace clears pinned context refs, model overrides, and prefill while initial mount preserves prefill', () => {
  useAssistantStore.setState({
    organizationId: null,
    prefill: { abilityId: 'write-composer:1', text: 'Draft launch thread' },
  })
  syncAssistantOrganization('org-1')
  assert.deepEqual(useAssistantStore.getState().prefill, {
    abilityId: 'write-composer:1',
    text: 'Draft launch thread',
  })
  toggleAssistantContextRef({ id: 'kit-1', kind: 'brand-kit', label: 'Primary' })
  setAssistantModelOverride('deep', 'high')
  assert.equal(useAssistantStore.getState().contextRefs.length, 1)
  assert.equal(useAssistantStore.getState().modelTierOverride, 'deep')
  syncAssistantOrganization('org-2')
  const after = useAssistantStore.getState()
  assert.deepEqual(after.contextRefs, [])
  assert.equal(after.modelTierOverride, null)
  assert.equal(after.effortOverride, null)
  assert.equal(after.prefill, null)
})

test('startAssistantOver and resumeAssistantThread reset per-thread model overrides and pinned context', (t) => {
  t.after(() => syncAssistantOrganization(null))
  toggleAssistantContextRef({ id: 'kit-1', kind: 'brand-kit', label: 'Primary' })
  setAssistantModelOverride('deep', 'high')
  startAssistantOver('home')
  assert.deepEqual(useAssistantStore.getState().contextRefs, [])
  assert.equal(useAssistantStore.getState().modelTierOverride, null)
  assert.equal(useAssistantStore.getState().effortOverride, null)

  toggleAssistantContextRef({ id: 'camp-1', kind: 'campaign', label: 'v2' })
  setAssistantModelOverride('balanced', 'low')
  resumeAssistantThread('home', 'thread-1', [{ kind: 'user', text: 'hi' }])
  assert.deepEqual(useAssistantStore.getState().contextRefs, [])
  assert.equal(useAssistantStore.getState().modelTierOverride, null)
  assert.equal(useAssistantStore.getState().effortOverride, null)
})

test('runUnifiedAssistant forwards modelTier, effort, and stripped contextRefs to /api/ai/assistant', async (t) => {
  let sentBody = ''
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    sentBody = String(init.body)
    const reply = {
      done: true,
      links: [],
      messages: [],
      pendingToolCalls: [],
      posts: [],
      text: 'Done.',
      toolSteps: [],
    }
    return new Response(JSON.stringify({ reply, type: 'reply' }) + '\n')
  })
  await runUnifiedAssistant({
    ask: 'Summarize',
    contextRefs: [{ id: 'kit-1', kind: 'brand-kit', label: 'a'.repeat(160) }],
    effort: 'high',
    memory: { current: [] },
    modelTier: 'deep',
    page: { area: 'home', entities: [], facts: [], path: '/home', title: 'Home' },
    push: () => {},
    signal: new AbortController().signal,
  })
  const parsed = JSON.parse(sentBody) as {
    contextRefs?: { id: string; kind: string; label?: string }[]
    effort?: string
    modelTier?: string
  }
  assert.equal(parsed.modelTier, 'deep')
  assert.equal(parsed.effort, 'high')
  assert.deepEqual(parsed.contextRefs, [{ id: 'kit-1', kind: 'brand-kit' }])
})

test('runUnifiedAssistant only transitions still-running tool activities to error on failure', async (t) => {
  let trip = 0
  t.mock.method(globalThis, 'fetch', async () => {
    trip += 1
    if (trip === 1) {
      const reply = {
        done: false,
        links: [],
        messages: [],
        pendingToolCalls: [{ input: {}, toolCallId: '1', toolName: 'inspectCanvas' }],
        posts: [],
        text: '',
        toolSteps: [],
      }
      return new Response(
        JSON.stringify({ name: 'inspectCanvas', type: 'tool' }) +
          '\n' +
          JSON.stringify({ reply, type: 'reply' }) +
          '\n'
      )
    }
    return new Response(
      JSON.stringify({ name: 'applyChanges', type: 'tool' }) +
        '\n' +
        JSON.stringify({ error: 'quota reached', type: 'error' }) +
        '\n'
    )
  })
  const transitions: { id: number; status: string }[] = []
  let nextId = 0
  await assert.rejects(() =>
    runUnifiedAssistant({
      ask: 'edit',
      executeClientTool: async () => ({ type: 'text', value: 'ok' }),
      memory: { current: [] },
      page: { area: 'editor', entities: [], facts: [], path: '/editor', title: 'Editor' },
      push: (entry) => (entry.kind === 'activity' ? ++nextId : undefined),
      signal: new AbortController().signal,
      updateActivity: (id, status) => transitions.push({ id, status }),
    })
  )
  // Tool #1 finished cleanly and must NOT be overwritten to error; tool #2 was running and turns error.
  assert.equal(transitions.filter((item) => item.id === 1).at(-1)?.status, 'done')
  assert.equal(transitions.filter((item) => item.id === 2).at(-1)?.status, 'error')
})

test('safeLinkHref blocks dangerous schemes and allows internal and https links', () => {
  assert.equal(safeLinkHref('javascript:alert(1)'), null)
  assert.equal(safeLinkHref('data:text/html,<script>alert(1)</script>'), null)
  assert.equal(safeLinkHref('//evil.test/phish'), null)
  assert.deepEqual(safeLinkHref('/settings/ai-models'), {
    external: false,
    href: '/settings/ai-models',
  })
  assert.deepEqual(safeLinkHref('https://shots.so/docs'), {
    external: true,
    href: 'https://shots.so/docs',
  })
})

test('every curated AI model tier has explicit pricing, tolerates null effort, and maps none surface to assistant', () => {
  for (const tier of AI_MODEL_TIER_LIST) {
    assert.ok(MODEL_PRICES[tier.modelId], `Missing pricing for ${tier.modelId}`)
  }
  assert.equal(surfaceToAiSlot('none'), 'assistant')
  const parsed = parseWorkspaceAiDefaults({
    default: { effort: null, tier: 'deep' },
  })
  assert.deepEqual(parsed.default, { effort: 'medium', tier: 'deep' })
  assert.equal(loadStoredAssistantMode(), null)
})

test('encodePcmWav writes 16kHz header and clamps out-of-range PCM samples accurately', () => {
  const clipped = new Float32Array([2.5, -2.5, 0, 0.5])
  const wav = encodePcmWav(clipped, 16_000)
  assert.equal(wav.byteLength, 44 + 8)
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  assert.equal(view.getUint32(24, true), 16_000)
  assert.equal(view.getInt16(44, true), 32_767)
  assert.equal(view.getInt16(46, true), -32_768)
  assert.equal(view.getInt16(48, true), 0)
  assert.equal(view.getInt16(50, true), 16_383)
})

test('workspaceAiSettingsUpdateSchema validates BYOK OpenRouter API keys and allows clearing', () => {
  assert.equal(
    workspaceAiSettingsUpdateSchema.safeParse({
      aiProviderApiKey: '  sk-or-v1-testkey1234567890abcd  ',
    }).success,
    true
  )
  assert.equal(
    workspaceAiSettingsUpdateSchema.safeParse({ aiProviderApiKey: 'a'.repeat(16) }).success,
    true
  )
  assert.equal(
    workspaceAiSettingsUpdateSchema.safeParse({ aiProviderApiKey: 'a'.repeat(512) }).success,
    true
  )
  assert.equal(workspaceAiSettingsUpdateSchema.safeParse({ aiProviderApiKey: null }).success, true)
  assert.equal(workspaceAiSettingsUpdateSchema.safeParse({ aiProviderApiKey: '' }).success, true)
  assert.equal(workspaceAiSettingsUpdateSchema.safeParse({ aiProviderApiKey: '   ' }).success, true)
  assert.equal(
    workspaceAiSettingsUpdateSchema.safeParse({ aiProviderApiKey: 'a'.repeat(15) }).success,
    false
  )
  assert.equal(
    workspaceAiSettingsUpdateSchema.safeParse({ aiProviderApiKey: 'a'.repeat(513) }).success,
    false
  )
  assert.equal(
    workspaceAiSettingsUpdateSchema.safeParse({ aiProviderApiKey: 'sk-or-v1-has space 12345678' })
      .success,
    false
  )
  assert.equal(
    workspaceAiSettingsUpdateSchema.safeParse({ aiProviderApiKey: 'sk-or-v1-newline\n12345678' })
      .success,
    false
  )
})
